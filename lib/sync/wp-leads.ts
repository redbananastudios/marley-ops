import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { landWebsiteLead, toTimestampOrNull } from "@/lib/leads/website-lead";
import { websiteLeadIngestSchema, firstIssueMessage, MIN_INGEST_SECRET_LENGTH } from "@/lib/leads/ingest";
import { decideEnquiryPushes } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";
import { errorContext, log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

/**
 * The Pitmans WordPress pull rail — the OTHER half of gate 19's ingest design
 * (multi-brand PRD §3.8), shipped together with the plugin because the plugin
 * alone is a silent-loss configuration.
 *
 * The plugin on pitmansremovals.co.uk persists every quote-form submission to
 * its own table BEFORE pushing it to /api/ingest/lead. This cron polls the
 * plugin's signed read endpoint every 15 minutes and lands anything the push
 * missed. The two channels are disjoint on purpose: a broken push (expired
 * secret, DNS, an unhooked form) leaves no trace on this side by definition,
 * so the only honest detector is a read over a path the push failure cannot
 * touch — the same shape as Marley's Sanity pull backing its instant push.
 *
 * Idempotent and safe on any cadence: reconciliation keys on
 * (brand='pitmans', external_lead_id), and `landWebsiteLead` adopts an
 * existing row rather than duplicating it, so a healthy push means every poll
 * counts `alreadyPresent` and writes nothing.
 *
 * No-backfill note: this rail deliberately does NOT apply LEAD_SYNC_SINCE (or
 * resolveSubmittedAt's 24h refusal) — a lead the push lost during a multi-day
 * outage is exactly what it exists to recover, however stale. The structural
 * guard against historical import is the source itself: the plugin's table
 * starts empty at install and only ever contains post-install submissions.
 */

/** Rows per page. With a cursor this is a PAGE SIZE, not a loss bound: the
 *  window starts at the first row we do not hold, so a backlog larger than
 *  this drains over successive polls and is counted as `unaccounted` in
 *  between — never silently skipped.
 *
 *  It used to say a lead only escapes recovery if more than this arrive
 *  between two polls. That was never the invariant the code provided: with
 *  the window anchored to the NEWEST row, the bound was a backlog, not a
 *  rate, and anything that fell behind it was gone for good. */
export const WP_PULL_LIMIT = 200;

/** How long one poll may take before it counts as a fetch failure. */
const FETCH_TIMEOUT_MS = 10_000;

/** Everything this rail lands belongs to Pitmans — the WordPress site is
 *  Pitmans' only, exactly as the Sanity rail is Marley's only (PRD §10). */
export const WP_PULL_BRAND = "pitmans";

/** Reconcile failures surface here (see syncWpLeads) — a submission the rail
 *  has SEEN but cannot land must be a standing visible fact, not a log line. */
export const WP_RECONCILE_ISSUE_KEY = "wp-leads:reconcile-failures";

/**
 * The id contract, shared with the plugin (plb_external_lead_id in
 * wordpress/pitmans-lead-bridge/pitmans-lead-bridge.php — the README there is
 * the spec): 'wp-' + row id zero-padded to 6 digits. Derived here from the
 * endpoint's own row id, never trusted from the stored payload, so a plugin
 * mapping bug cannot fork the id space. Padding matters: the ingest schema
 * requires ids of 8+ characters, and 'wp-1' is four.
 */
export function wpExternalLeadId(rowId: number): string {
  return `wp-${String(Math.trunc(rowId)).padStart(6, "0")}`;
}

/**
 * Sign one poll. The canonical string is exactly `limit=<n>&ts=<unix>` —
 * plain integers, that order, nothing else — HMAC-SHA256, hex. The verifying
 * half is plb_rest_permission in the plugin; change both together or not at
 * all. `ts` bounds replay to ±300s on the plugin side.
 */
export function signPullQuery(
  limit: number,
  sinceId: number,
  tsSeconds: number,
  secret: string,
): string {
  const canonical = `limit=${Math.trunc(limit)}&since_id=${Math.trunc(sinceId)}&ts=${Math.trunc(tsSeconds)}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/** The full signed URL for one poll against the plugin's REST route. */
export function buildPullUrl(
  baseUrl: string,
  limit: number,
  sinceId: number,
  tsSeconds: number,
  secret: string,
): string {
  const sig = signPullQuery(limit, sinceId, tsSeconds, secret);
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}limit=${Math.trunc(limit)}&since_id=${Math.trunc(sinceId)}&ts=${Math.trunc(tsSeconds)}&sig=${sig}`;
}

/**
 * The highest plugin row id below which EVERY row has landed here.
 *
 * Derived from our own leads table, never persisted: a stored cursor is state
 * that can be lost or reset, and a lost cursor skips rows in silence, which is
 * the exact failure this rail exists to make impossible. The leads table
 * already records what landed, so it IS the record of what has been
 * reconciled.
 *
 * Stopping at the first gap is deliberate. A submission we cannot land keeps
 * the cursor beneath it, so it is re-offered on every poll rather than
 * scrolling away. The cost is that a permanently unlandable row pins the
 * window: rows beyond it are only reachable while they fit inside one page.
 * That is a LOUD failure, not a silent one — `unaccounted` below counts them
 * and holds the operational issue open until a human clears the blockage.
 */
export function contiguousReconciledUpTo(ids: ReadonlySet<number>): number {
  let n = 0;
  while (ids.has(n + 1)) n += 1;
  return n;
}

/**
 * Every plugin row id this rail already holds, read from OUR side.
 *
 * Returns the error rather than an empty set on failure: an unreadable leads
 * table must not look like a rail that has landed nothing, which would reset
 * the cursor to zero and re-offer every row as if new.
 */
async function reconciledRowIds(sb: Sb): Promise<Set<number> | { error: string }> {
  const { data, error } = await sb
    .from("leads")
    .select("external_lead_id")
    .eq("brand", WP_PULL_BRAND)
    .like("external_lead_id", "wp-%");
  if (error) return { error: error.message };
  const ids = new Set<number>();
  for (const row of (data ?? []) as { external_lead_id: string | null }[]) {
    const m = /^wp-(\d+)$/.exec(row.external_lead_id ?? "");
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

export type WpPullConfig =
  /** Both env vars present and plausible — poll. */
  | { state: "configured"; url: string; secret: string }
  /** Neither set: the rail is not wired yet (the route ships ahead of the
   *  plugin install). NOT an error, but never silent either. */
  | { state: "absent" }
  /** Half-configured or a placeholder-short secret — someone TRIED to wire
   *  this and it cannot work. A real failure, never "disabled and fine". */
  | { state: "broken"; reason: string };

export function resolveWpPullConfig(
  env: Record<string, string | undefined> = process.env,
): WpPullConfig {
  const url = (env.PITMANS_WP_PULL_URL ?? "").trim();
  const secret = (env.PITMANS_WP_PULL_SECRET ?? "").trim();
  if (!url && !secret) return { state: "absent" };
  if (!url) return { state: "broken", reason: "PITMANS_WP_PULL_SECRET is set but PITMANS_WP_PULL_URL is not" };
  if (!secret) return { state: "broken", reason: "PITMANS_WP_PULL_URL is set but PITMANS_WP_PULL_SECRET is not" };
  if (secret.length < MIN_INGEST_SECRET_LENGTH) {
    return { state: "broken", reason: "PITMANS_WP_PULL_SECRET is shorter than 16 characters — a placeholder, not a credential" };
  }
  // https ONLY, not http: this endpoint returns whole customer records — name,
  // phone, email, both addresses — up to WP_PULL_LIMIT rows per poll, and the
  // request's HMAC signature rides in the query string where an on-path
  // observer could replay it inside the 300s window. The plugin lives on a
  // public WordPress host that already serves https, so there is no legitimate
  // plaintext caller to accommodate; a typo'd http:// URL must fail loudly
  // rather than quietly downgrade every 15-minute poll to cleartext.
  if (!/^https:\/\//.test(url)) {
    return { state: "broken", reason: "PITMANS_WP_PULL_URL is not an https:// URL" };
  }
  return { state: "configured", url, secret };
}

/** One row as the plugin's read endpoint returns it. `payload.ingest` is the
 *  mapped lead (sans leadId — derived from `id`); `payload.raw` is debugging
 *  material this side never reads. Unknown keys pass through untouched. */
const wpSubmissionSchema = z.object({
  id: z.number().int().positive(),
  form_id: z.number().int().nonnegative().optional(),
  submitted_at: z.string(),
  pushed_at: z.string().nullable().optional(),
  payload: z.looseObject({ ingest: z.record(z.string(), z.unknown()).optional() }).optional(),
});

const wpPullResponseSchema = z.object({
  ok: z.boolean().optional(),
  /** Rows in the plugin's whole table. Optional in SHAPE only — an endpoint
   *  that omits it proves nothing, and is handled below as UNKNOWN, never as
   *  zero. */
  total: z.number().int().nonnegative().optional(),
  submissions: z.array(z.unknown()),
});

export interface WpLeadsSummary {
  /** runCron treats `ok: false` as a FAILED run. False whenever the poll
   *  could not actually read the WordPress table — config broken, endpoint
   *  unreachable, response unusable — so "the rail is dead" can never render
   *  as a healthy pass. The deliberate exception is `configured: false`
   *  below. */
  ok: boolean;
  /** False while the env is not wired. The run is "successful" then only in
   *  the narrow sense that nothing was skipped silently: the summary and the
   *  log both shout it, and the README makes this state part of the install
   *  checklist. It must not page every 15 minutes for a rail that is not
   *  supposed to exist yet — but it must never read as clean either. */
  configured: boolean;
  warning?: string;
  error?: string;
  /** Rows the endpoint returned this poll. */
  seen: number;
  /** Rows already landed (by push, or by an earlier poll). The healthy
   *  steady state is seen === alreadyPresent. */
  alreadyPresent: number;
  /** Rows the push missed that THIS poll landed — each one is a recovered
   *  enquiry, i.e. evidence the push channel dropped something. */
  inserted: number;
  /** Rows that could not be landed (schema-invalid payload, insert error).
   *  Reported as a standing operational issue, retried next poll. */
  failures: number;
  /** Where this poll's window started — the highest id below which every
   *  plugin row has landed here. */
  sinceId: number;
  /** Submissions on the WordPress side this rail has neither landed nor seen.
   *  `null` means the endpoint reported no total, i.e. UNKNOWN — which is a
   *  different answer from 0 and must never resolve the issue. */
  unaccounted: number | null;
  firstError?: string;
}

const emptyCounts = {
  seen: 0,
  alreadyPresent: 0,
  inserted: 0,
  failures: 0,
  sinceId: 0,
  unaccounted: null,
};

/**
 * One poll-and-reconcile pass. Called by /api/cron/wp-leads every 15 minutes;
 * `fetchImpl`/`now` are injectable for tests only.
 *
 * Repeated fetch failures reach a human through the existing alert machinery,
 * not a bespoke one: each failed pass is a failed cron run (runCron files the
 * `cron:wp-leads` operational issue), and once the newest SUCCESSFUL run is
 * older than the registry's maxAgeMins the health watchdog SMSes — the same
 * disjoint path every other automation here is watched by.
 */
export async function syncWpLeads(
  sb: Sb,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<WpLeadsSummary> {
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;

  const config = resolveWpPullConfig();
  if (config.state === "absent") {
    // LOUD by contract: a skipped check must never read as clean. The summary
    // says so on /automations, the log says so every pass, and the plugin
    // README names this exact report as the un-finished-install signal.
    const warning =
      "PITMANS_WP_PULL_URL/PITMANS_WP_PULL_SECRET are not set — the WordPress pull rail is NOT running. " +
      "If the Pitmans lead-bridge plugin is live, its push currently has no backstop and a push failure loses enquiries silently.";
    log.warn("wp-leads.not_configured", {});
    return { ok: true, configured: false, warning, ...emptyCounts };
  }
  if (config.state === "broken") {
    log.error("wp-leads.config_broken", { reason: config.reason });
    return { ok: false, configured: false, error: config.reason, ...emptyCounts };
  }

  // ---- Anchor the window to what has actually been reconciled --------------
  // A failed read here is a FAILED run, not a poll from zero: guessing the
  // cursor is exactly how a rail skips rows while reporting success.
  const held = await reconciledRowIds(sb);
  if (!(held instanceof Set)) {
    log.error("wp-leads.cursor_read_failed", { error: held.error });
    return {
      ok: false,
      configured: true,
      error: `WP pull cursor read failed: ${held.error}`,
      ...emptyCounts,
    };
  }
  const sinceId = contiguousReconciledUpTo(held);

  // ---- Fetch over the disjoint channel -------------------------------------
  const url = buildPullUrl(
    config.url,
    WP_PULL_LIMIT,
    sinceId,
    Math.floor(now.getTime() / 1000),
    config.secret,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url, { cache: "no-store", signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const detail = errorContext(err);
    log.error("wp-leads.fetch_failed", detail);
    return { ok: false, configured: true, error: `WP pull fetch failed: ${detail.error}`, ...emptyCounts };
  }
  clearTimeout(timer);

  if (!res.ok) {
    // The body is the plugin's own diagnostic (403 bad signature / clock skew,
    // 503 unconfigured pull secret) — worth carrying, but bounded.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    log.error("wp-leads.fetch_rejected", { status: res.status, body });
    return {
      ok: false,
      configured: true,
      error: `WP pull endpoint answered ${res.status}${body ? `: ${body}` : ""}`,
      ...emptyCounts,
    };
  }

  let parsed: z.infer<typeof wpPullResponseSchema>;
  try {
    parsed = wpPullResponseSchema.parse(await res.json());
  } catch (err) {
    const detail = errorContext(err);
    log.error("wp-leads.response_unusable", detail);
    return { ok: false, configured: true, error: `WP pull response unusable: ${detail.error}`, ...emptyCounts };
  }

  // ---- Reconcile -----------------------------------------------------------
  // The endpoint answers oldest-first FROM the cursor, so this is already
  // submission order — nothing to reverse, and nothing behind it to miss. One
  // bad row must not abort the batch: each is isolated, counted, and retried
  // next poll.
  const rows = parsed.submissions;

  let alreadyPresent = 0;
  let inserted = 0;
  let failures = 0;
  let firstError: string | undefined;
  const failedIds: (number | string)[] = [];
  const insertedLeads: { id: string; name: string | null; submittedAt: string | null }[] = [];

  for (const raw of rows) {
    const sub = wpSubmissionSchema.safeParse(raw);
    if (!sub.success) {
      failures += 1;
      const id = (raw as { id?: unknown })?.id;
      failedIds.push(typeof id === "number" ? id : "unknown-shape");
      if (!firstError) firstError = firstIssueMessage(sub.error);
      continue;
    }
    const externalLeadId = wpExternalLeadId(sub.data.id);
    try {
      // The stored ingest fields plus the id derived HERE, validated through
      // the SAME schema the push route enforces — both rails provably accept
      // one contract, so a submission cannot land via pull that the push
      // would have refused (or vice versa). resolveSubmittedAt's 24h refusal
      // is deliberately not applied: recovering stale losses is the job.
      const ingest = websiteLeadIngestSchema.safeParse({
        ...(sub.data.payload?.ingest ?? {}),
        leadId: externalLeadId,
      });
      if (!ingest.success) {
        failures += 1;
        failedIds.push(sub.data.id);
        if (!firstError) firstError = `${externalLeadId}: ${firstIssueMessage(ingest.error)}`;
        continue;
      }
      const input = ingest.data;
      // Freshness anchor mirrors the Sanity rail: the payload's own timestamp
      // first, the endpoint's row timestamp as fallback — a genuinely new
      // enquiry must never be silently skipped by the alert.
      const submittedAt =
        toTimestampOrNull(input.submittedAt) ?? toTimestampOrNull(sub.data.submitted_at);

      const landed = await landWebsiteLead(
        sb,
        {
          brand: WP_PULL_BRAND,
          externalLeadId,
          name: input.name,
          phone: input.phone,
          email: input.email,
          fromPostcode: input.fromPostcode,
          toPostcode: input.toPostcode,
          propertySize: input.propertySize,
          preferredDate: input.preferredDate,
          services: input.services,
          notes: input.notes,
          sourceForm: input.source,
          referrerAnswer: input.referrer,
          submittedAt,
          status: "website_enquiry",
          attribution: input.attribution,
        },
        now,
      );
      if (landed.created) {
        inserted += 1;
        insertedLeads.push({ id: landed.leadId, name: input.name ?? null, submittedAt });
        log.info("wp-leads.recovered", { externalLeadId, leadId: landed.leadId });
      } else {
        alreadyPresent += 1;
      }
    } catch (err) {
      failures += 1;
      failedIds.push(sub.data.id);
      if (!firstError) firstError = errorContext(err).error;
    }
  }

  // Office push for freshly-recovered enquiries — identical to the other two
  // delivery routes (best-effort, never throws; the freshness window keeps a
  // stale recovery silent while a live one pages).
  for (const event of decideEnquiryPushes(insertedLeads, now)) {
    await sendPushForEvent(event);
  }

  // Failures are a STANDING issue, not just a count in one run's JSON: the
  // run itself stays ok (the check ran; the rail is alive) so one permanently
  // unlandable submission cannot page every 15 minutes as a dead rail — but a
  // submission we have seen and cannot land is a customer waiting, so it must
  // sit visibly open until it lands or a human deals with it.
  // Prove nothing is missing, rather than inferring it from a window that by
  // construction cannot show what it excluded. `total` is the plugin's whole
  // table; what we can account for is what we already hold, plus what this
  // poll landed, plus what this poll saw and could not land. Anything left
  // over is a submission this rail has never been offered.
  const unlandedSeen = failedIds.filter(
    (id) => typeof id !== "number" || !held.has(id),
  ).length;
  const accountedFor = held.size + inserted + unlandedSeen;
  const unaccounted =
    parsed.total === undefined ? null : Math.max(0, parsed.total - accountedFor);

  // The resolve is deliberately NOT gated on `failures === 0` alone. Under the
  // old newest-N window a lost row simply left the window, `failures` read 0,
  // and this call marked the loss RESOLVED — the monitor erasing the only
  // evidence of the thing it exists to catch. An endpoint reporting no total
  // proves nothing either way, so it does not resolve either: "I could not
  // check" is not "nothing to report".
  if (failures > 0 || unaccounted === null || unaccounted > 0) {
    const parts: string[] = [];
    if (failures > 0) parts.push(`${failures} submission(s) could not be landed as leads`);
    if (unaccounted === null) {
      parts.push(
        "the endpoint reported no table total, so this rail cannot prove nothing else is missing",
      );
    } else if (unaccounted > 0) {
      parts.push(
        `${unaccounted} submission(s) exist on the WordPress side that this rail has not reached`,
      );
    }
    log.error("wp-leads.reconcile_failures", {
      failures,
      unaccounted,
      sinceId,
      failedIds,
      firstError,
    });
    await reportOperationalIssue(sb, {
      key: WP_RECONCILE_ISSUE_KEY,
      severity: "warning",
      source: "wp-leads",
      event: "wp_leads.reconcile_failed",
      message: `Pitmans WordPress submissions are unaccounted for: ${parts.join("; ")}. They retry each poll, but a persistent entry here is an enquiry no one is answering.`,
      context: { failures, unaccounted, sinceId, failedIds: failedIds.slice(0, 20), firstError },
    });
  } else {
    await resolveOperationalIssue(sb, WP_RECONCILE_ISSUE_KEY);
  }

  return {
    ok: true,
    configured: true,
    seen: rows.length,
    sinceId,
    unaccounted,
    alreadyPresent,
    inserted,
    failures,
    ...(firstError ? { firstError } : {}),
  };
}
