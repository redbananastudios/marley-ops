/**
 * Did the website's enquiry PUSH actually reach us?
 *
 * A website enquiry gets to marley-ops down two independent rails: an immediate
 * `POST /api/ingest/lead` from the site (sub-second), and the Sanity pull that
 * `syncSanityLeads` runs on dashboard load and daily at 06:00 (minutes to a day).
 * The push is deliberately fail-soft on the site, and the pull is its backstop —
 * which is exactly why a broken push is invisible from in here. The lead still
 * lands, just slowly, and nothing in this codebase would ever say so. It has
 * already happened once: the site shipped the push dormant, and enquiries took
 * up to 84 minutes with no signal that anything was degraded.
 *
 * The site writes a per-enquiry `leadDelivery` audit doc to Sanity recording the
 * outcome of every channel it tried, including `opsIngest`. Until this module it
 * had no reader in any codebase. Reading it is what turns "the push is fine, we
 * think" into a checkable claim — and it is a genuinely disjoint channel from
 * the push itself, so this alarm cannot be silenced by the fault it watches for.
 *
 * Pure selection only. The Sanity fetch and the alerting live in
 * `lib/sync/lead-delivery-watch.ts`, so the rules here stay unit-testable.
 */

export interface OpsIngestChannel {
  ok?: boolean | null;
  skipped?: boolean | null;
  error?: string | null;
  attempts?: number | null;
}

export interface LeadDeliveryDoc {
  _id: string;
  _createdAt: string;
  leadId?: string | null;
  channels?: { opsIngest?: OpsIngestChannel | null } | null;
}

export interface DeliveryFault {
  docId: string;
  leadId: string | null;
  at: string;
  /** Why this counts as a fault, in words an ops alert can print verbatim. */
  reason: string;
}

/**
 * The instant the ops push went live on the production site.
 *
 * Before this, `opsIngest` legitimately reads `skipped: true, "ops ingest not
 * configured"` — the feature shipped dormant on purpose so it could deploy ahead
 * of the switch. Those docs are NOT faults and must never alert. Verified from
 * the live data: the 2026-08-21T07:47Z delivery records "not configured", the
 * 13:29Z one records a real push landing in 0.4s, and the Vercel production env
 * vars `MARLEY_OPS_INGEST_URL`/`_SECRET` are both stamped 2026-08-21.
 *
 * Overridable so a redeploy or a second site never needs a code change.
 */
export const DEFAULT_PUSH_LIVE_SINCE = "2026-08-21T12:00:00Z";

export function resolvePushFloor(raw: string | undefined | null): string {
  const candidate = (raw ?? "").trim();
  if (!candidate) return DEFAULT_PUSH_LIVE_SINCE;
  const t = new Date(candidate);
  // A garbled override must not widen the window back over the dormant era and
  // alert on every pre-go-live doc — fall back to the known-good floor.
  return Number.isNaN(t.getTime()) ? DEFAULT_PUSH_LIVE_SINCE : t.toISOString();
}

/**
 * Classify ONE delivery. Returns null when the push demonstrably worked.
 *
 * Anything other than an explicit `ok: true` is a fault, `skipped` included:
 * since the floor above, "skipped" means the site lost its ingest configuration,
 * which is precisely the silent regression this exists to catch. A missing
 * `opsIngest` key is a fault too — the site records the channel on every
 * enquiry, so its absence means an older build is serving, not that all is well.
 */
export function opsIngestFault(doc: LeadDeliveryDoc): DeliveryFault | null {
  const base = { docId: doc._id, leadId: doc.leadId ?? null, at: doc._createdAt };
  const ch = doc.channels?.opsIngest;
  if (!ch) return { ...base, reason: "no opsIngest result recorded — the site is running a build that predates the push" };
  if (ch.ok === true) return null;
  const detail = ch.error?.trim();
  if (ch.skipped === true) {
    return { ...base, reason: `push dormant — ${detail || "the site skipped ops ingest"}` };
  }
  return { ...base, reason: `push failed — ${detail || "no error recorded"}` };
}

/**
 * Faults among `docs`, restricted to deliveries at or after the push floor and
 * within `windowHours` of `now`. Newest first.
 */
export function selectOpsIngestFaults(
  docs: LeadDeliveryDoc[],
  opts: { now: Date; windowHours: number; pushFloor: string },
): DeliveryFault[] {
  const floor = Math.max(new Date(opts.pushFloor).getTime(), opts.now.getTime() - opts.windowHours * 3_600_000);
  return docs
    .filter((d) => {
      const t = new Date(d._createdAt).getTime();
      return Number.isFinite(t) && t >= floor;
    })
    .map(opsIngestFault)
    .filter((f): f is DeliveryFault => f !== null)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
