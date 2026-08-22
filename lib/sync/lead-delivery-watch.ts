import { sendOpsAlert } from "@/lib/comms/dispatch";
import { log } from "@/lib/log";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  resolvePushFloor,
  selectOpsIngestFaults,
  type DeliveryFault,
  type LeadDeliveryDoc,
} from "./lead-delivery-health";

/**
 * Watch the website's enquiry PUSH by reading the site's own delivery audit.
 *
 * See `lead-delivery-health.ts` for why this exists at all: the push is
 * fail-soft and the Sanity pull is its backstop, so a broken push loses nothing
 * and says nothing — enquiries simply go from arriving in under a second to
 * arriving in up to an hour and a half, silently. Nothing in this codebase could
 * previously tell the difference, because a push that never happened leaves no
 * trace here by definition.
 *
 * The signal therefore has to come from a channel the fault cannot touch. The
 * site writes a `leadDelivery` doc to Sanity per enquiry recording every channel
 * it attempted; this reads that. Sanity is disjoint from the ops-ingest HTTP
 * path, so the thing being watched cannot silence its own alarm.
 */

/** Stable key so a repeat run updates one issue rather than stacking new ones. */
export const LEAD_PUSH_ISSUE_KEY = "lead-push:ops-ingest";

/**
 * Separate key for "the check itself could not run".
 *
 * Kept distinct from the fault key on purpose: a watcher that cannot read its
 * source knows nothing, and reporting that as a clean bill of health is the
 * exact failure this whole module exists to prevent. An unreachable source and
 * an empty result are different answers and must not share a rendering.
 */
export const LEAD_PUSH_CHECK_ISSUE_KEY = "lead-push:check-unavailable";

const DEFAULT_WINDOW_HOURS = 72;
/** Upper bound on one query. Hitting it is logged, never treated as full coverage. */
const DOC_CAP = 200;

export interface DeliveryWatchResult {
  /** false means the check could not run — never "nothing found". */
  ok: boolean;
  checked: number;
  faults: number;
  windowHours: number;
  /** The floor actually applied, so a report can say what it looked at. */
  since: string;
  error?: string;
}

/**
 * Record that the check could not run, and say so out loud. Never silently
 * returns an empty, healthy-looking result.
 */
async function unavailable(error: string, windowHours: number, since: string): Promise<DeliveryWatchResult> {
  await reportOperationalIssue(createAdminClient(), {
    key: LEAD_PUSH_CHECK_ISSUE_KEY,
    severity: "warning",
    source: "lead-delivery-watch",
    event: "lead_push.check_unavailable",
    message: `Could not check whether website enquiries are reaching ops instantly: ${error}. This is not a clean result — the push may be broken and unreported.`,
    context: { error, since, windowHours },
  });
  return { ok: false, checked: 0, faults: 0, windowHours, since, error };
}

export async function watchLeadDeliveries(
  opts: { now?: Date; windowHours?: number } = {},
): Promise<DeliveryWatchResult> {
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const pushFloor = resolvePushFloor(process.env.LEAD_PUSH_SINCE);
  const since = new Date(
    Math.max(new Date(pushFloor).getTime(), now.getTime() - windowHours * 3_600_000),
  ).toISOString();

  const projectId = process.env.SANITY_PROJECT_ID || "963i5lvk";
  const dataset = process.env.SANITY_DATASET || "production";
  const token = process.env.SANITY_API_READ_TOKEN;
  // A missing token is "I could not check", which must not read as "all clear".
  if (!token) return unavailable("Sanity read token not configured", windowHours, since);

  // Project ONLY the delivery outcome. These docs also carry the enquirer's
  // name, email, phone and both postcodes; none of that is needed to answer
  // "did the push land", and pulling it would put customer PII into cron logs
  // and ops alerts for no reason.
  const groq =
    `*[_type=="leadDelivery" && _createdAt >= "${since}"]` +
    `| order(_createdAt desc)[0...${DOC_CAP}]{_id,_createdAt,leadId,channels{opsIngest}}`;
  const url = `https://${projectId}.api.sanity.io/v2021-10-21/data/query/${dataset}?query=${encodeURIComponent(groq)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let docs: LeadDeliveryDoc[];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return unavailable(`Sanity query failed (${res.status})`, windowHours, since);
    const body = (await res.json()) as { result?: LeadDeliveryDoc[] };
    if (!Array.isArray(body.result)) return unavailable("Sanity returned no result array", windowHours, since);
    docs = body.result;
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : "Sanity fetch failed", windowHours, since);
  } finally {
    clearTimeout(timer);
  }

  // Never let a bound on coverage pass as full coverage: at the cap we are no
  // longer looking at the whole window, and a silent truncation would read as
  // "checked everything, found nothing".
  if (docs.length >= DOC_CAP) {
    log.warn("lead-push.window_truncated", { cap: DOC_CAP, since, windowHours });
  }

  const faults = selectOpsIngestFaults(docs, { now, windowHours, pushFloor });
  const sb = createAdminClient();
  // The read succeeded, so whatever was stopping it has cleared.
  await resolveOperationalIssue(sb, LEAD_PUSH_CHECK_ISSUE_KEY);

  if (faults.length === 0) {
    // Only a check that actually ran may clear the issue.
    await resolveOperationalIssue(sb, LEAD_PUSH_ISSUE_KEY);
    log.info("lead-push.healthy", { checked: docs.length, since, windowHours });
    return { ok: true, checked: docs.length, faults: 0, windowHours, since };
  }

  await raise(sb, faults, docs.length, since);
  return { ok: true, checked: docs.length, faults: faults.length, windowHours, since };
}

async function raise(
  sb: ReturnType<typeof createAdminClient>,
  faults: DeliveryFault[],
  checked: number,
  since: string,
): Promise<void> {
  const newest = faults[0];
  const message =
    `${faults.length} of ${checked} website enquiries since ${since.slice(0, 16).replace("T", " ")} did not reach ` +
    `the ops panel by the instant push. They still arrive via the Sanity sync, but minutes to hours late instead ` +
    `of instantly. Most recent: ${newest.reason}`;

  await reportOperationalIssue(sb, {
    key: LEAD_PUSH_ISSUE_KEY,
    severity: "warning", // the pull backstop means nothing is LOST, only delayed
    source: "lead-delivery-watch",
    event: "lead_push.degraded",
    message,
    context: { faults: faults.length, checked, since, docIds: faults.map((f) => f.docId).slice(0, 20) },
  });

  await sendOpsAlert(
    "Website enquiries are not reaching ops instantly",
    [
      message,
      "",
      "Most likely cause: MARLEY_OPS_INGEST_URL / MARLEY_OPS_INGEST_SECRET missing from the",
      "website's Vercel production environment, or LEAD_INGEST_SECRET changed on the ops box",
      "without the site being updated to match.",
      "",
      "Nothing is lost — the Sanity pull still lands every enquiry. This is about speed.",
      "",
      ...faults.slice(0, 10).map((f) => `- ${f.at.slice(0, 16).replace("T", " ")} lead ${f.leadId ?? "?"}: ${f.reason}`),
    ],
    "system",
    // Keyed on the offending deliveries, so a daily re-run of the SAME fault is
    // silent but a new failing enquiry alerts again.
    `lead-push:${faults.map((f) => f.docId).sort().join(",")}`,
  );
}
