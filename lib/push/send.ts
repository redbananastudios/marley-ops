/**
 * The push sender — the ONLY thing that talks to browser push services.
 *
 * Fired from authoritative commit points (web-lead sync insert, deposit /
 * balance paid) strictly AFTER the business transaction has won its
 * idempotency gate. Best-effort by contract (PRD §4): this module never
 * throws — a push failure must never fail or roll back the originating
 * business operation. The long-lived Docker runtime makes a bounded awaited
 * fan-out safe (no serverless freeze risk).
 *
 * Kill switches: business_settings.push_enabled (global) + one column per
 * category — checked on every send, so pushes stop instantly without a deploy.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errorContext } from "@/lib/log";
import { PUSH_CATEGORIES, type PushCategoryId, type PushEvent } from "./categories";
import { buildPushPayload } from "./payload";
import { realPushTransport, vapidConfigured, type PushTransport } from "./transport";

// Loosely typed on purpose: the same pattern the passkey/cubic modules use for
// service-role tables the generated types file tracks manually.
type Sb = SupabaseClient;

/** sha256 hex of the endpoint — the lookup/uniqueness key, and the ONLY form
 *  of the endpoint that ever appears in a log line (first 12 chars). */
export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

const redact = (hash: string) => hash.slice(0, 12);

export interface PushFlags {
  enabled: boolean;
  categories: Record<PushCategoryId, boolean>;
}

export async function getPushFlags(sb: Sb): Promise<PushFlags> {
  const { data, error } = await sb
    .from("business_settings")
    .select(
      "push_enabled, push_new_enquiry_enabled, push_payment_event_enabled, push_crew_job_enabled, push_fleet_expiry_enabled, push_survey_assigned_enabled",
    )
    .eq("id", true)
    .maybeSingle();
  // THROW, don't fail soft: `data?.push_enabled === true` turns a failed read
  // into "push is switched off", which is indistinguishable from the office
  // deliberately disabling it — so every notification stops and the surface
  // that would say so is the one that broke. Same bug class as the fleet
  // reminders that silently stopped sending (fixed c3652de); the caller
  // (sendPushForEvent) catches and reports it as a send error.
  if (error) throw new Error(`push flags read failed: ${error.message}`);
  return {
    enabled: data?.push_enabled === true,
    categories: {
      new_enquiry: data?.push_new_enquiry_enabled !== false,
      payment_event: data?.push_payment_event_enabled !== false,
      crew_job: data?.push_crew_job_enabled !== false,
      fleet_expiry: data?.push_fleet_expiry_enabled !== false,
      survey_assigned: data?.push_survey_assigned_enabled !== false,
    },
  };
}

/** Pure recipient resolution (tested): active users whose role is in the
 *  category's audience, minus the actor (never notify someone about their own
 *  action), minus anyone who opted the category off. */
export function resolvePushRecipients(
  category: PushCategoryId,
  profiles: readonly { id: string; role: string; active: boolean }[],
  prefs: ReadonlyMap<string, Record<string, unknown>>,
  actorUserId: string | null | undefined,
): string[] {
  const def = PUSH_CATEGORIES[category];
  return profiles
    .filter((p) => p.active && (def.audience as readonly string[]).includes(p.role))
    .filter((p) => p.id !== actorUserId)
    .filter((p) => {
      const map = prefs.get(p.id);
      const choice = map?.[category];
      return typeof choice === "boolean" ? choice : def.defaultEnabled;
    })
    .map((p) => p.id);
}

export interface PushSendSummary {
  attempted: number;
  accepted: number;
  pruned: number;
  failed: number;
  skipped?: "disabled" | "unconfigured" | "no_recipients" | "error";
}

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth_secret: string;
  failure_count: number;
}

/**
 * Resolve recipients → active subscriptions → fan out one event.
 * Never throws. `onlyUserId` restricts delivery to one user's own devices
 * (the admin self-test path).
 */
export async function sendPushForEvent(
  event: PushEvent,
  opts: {
    actorUserId?: string | null;
    onlyUserId?: string;
    /** Target SPECIFIC users (e.g. the crew member just assigned) instead of
     *  the whole role audience. Audience/active/preference rules still apply. */
    recipientUserIds?: string[];
    /** Admin self-test: respects the global switch but not the per-category
     *  one (the test proves transport, not category policy). */
    isTest?: boolean;
    admin?: Sb;
    transport?: PushTransport;
    now?: Date;
  } = {},
): Promise<PushSendSummary> {
  const none: PushSendSummary = { attempted: 0, accepted: 0, pruned: 0, failed: 0 };
  try {
    const admin = opts.admin ?? (createAdminClient() as unknown as Sb);
    const transport = opts.transport ?? realPushTransport;
    const now = opts.now ?? new Date();
    const def = PUSH_CATEGORIES[event.category];

    if (!vapidConfigured()) return { ...none, skipped: "unconfigured" };
    const flags = await getPushFlags(admin);
    if (!flags.enabled) return { ...none, skipped: "disabled" };
    if (!opts.isTest && !flags.categories[event.category]) return { ...none, skipped: "disabled" };

    // Recipients.
    let userIds: string[];
    if (opts.onlyUserId) {
      userIds = [opts.onlyUserId];
    } else {
      let profileQuery = admin.from("profiles").select("id, role, active");
      if (opts.recipientUserIds) {
        if (opts.recipientUserIds.length === 0) return { ...none, skipped: "no_recipients" };
        profileQuery = profileQuery.in("id", opts.recipientUserIds);
      }
      // Same reasoning as getPushFlags: a failed recipients read would resolve
      // to "nobody to notify" and the event would be dropped silently.
      const { data: profiles, error: profileErr } = await profileQuery;
      if (profileErr) throw new Error(`push recipients read failed: ${profileErr.message}`);
      const { data: prefRows } = await admin.from("push_preferences").select("user_id, categories");
      const prefs = new Map<string, Record<string, unknown>>(
        (prefRows ?? []).map((r: { user_id: string; categories: unknown }) => [
          r.user_id,
          (r.categories ?? {}) as Record<string, unknown>,
        ]),
      );
      userIds = resolvePushRecipients(event.category, profiles ?? [], prefs, opts.actorUserId);
    }
    if (userIds.length === 0) return { ...none, skipped: "no_recipients" };

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, endpoint_hash, p256dh, auth_secret, failure_count")
      .in("user_id", userIds)
      .eq("status", "active");
    const targets = (subs ?? []) as SubRow[];
    if (targets.length === 0) return { ...none, skipped: "no_recipients" };

    const payloadFor = (endpoint: string) =>
      JSON.stringify(
        buildPushPayload({
          tag: event.eventKey,
          category: event.category,
          title: event.title,
          body: event.body,
          url: event.url,
          // WebKit REQUIRES every push to show a notification — a few
          // "silently handled" pushes and Safari revokes the subscription.
          // So Apple endpoints never suppress; the focused-window rule only
          // applies to Chromium-family push services.
          suppressWhenFocused:
            def.suppressWhenFocused && !endpoint.startsWith("https://web.push.apple.com/"),
          now,
        }),
      );

    const summary: PushSendSummary = { attempted: targets.length, accepted: 0, pruned: 0, failed: 0 };
    // Small recipient sets (a handful of office users) — sequential fan-out is
    // bounded and keeps the failure handling dead simple.
    for (const sub of targets) {
      const res = await transport(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
        payloadFor(sub.endpoint),
        { ttlSeconds: def.ttlSeconds, urgency: def.urgency },
      );
      const ts = new Date().toISOString();
      if (res.ok) {
        summary.accepted += 1;
        await admin
          .from("push_subscriptions")
          .update({ last_success_at: ts, failure_count: 0, updated_at: ts })
          .eq("id", sub.id);
      } else if (res.kind === "gone") {
        // 404/410 — the browser subscription no longer exists. Prune it.
        summary.pruned += 1;
        await admin
          .from("push_subscriptions")
          .update({ status: "invalid", revoked_at: ts, last_failure_at: ts, updated_at: ts })
          .eq("id", sub.id);
        log.info("push.subscription.pruned", { endpoint: redact(sub.endpoint_hash), category: event.category });
      } else {
        summary.failed += 1;
        // A subscription that NEVER succeeds (e.g. garbage keys, dead but
        // non-410 endpoint) must not be retried forever — retire it after a
        // run of consecutive failures.
        const failures = sub.failure_count + 1;
        const retire = failures >= 8;
        await admin
          .from("push_subscriptions")
          .update({
            last_failure_at: ts,
            failure_count: failures,
            updated_at: ts,
            ...(retire ? { status: "invalid", revoked_at: ts } : {}),
          })
          .eq("id", sub.id);
        log.warn("push.send.failed", {
          endpoint: redact(sub.endpoint_hash),
          category: event.category,
          kind: res.kind,
          status: res.status,
          ...(retire ? { retired: true } : {}),
        });
      }
    }

    log.info("push.event.sent", {
      category: event.category,
      eventKey: event.eventKey,
      ...summary,
    });
    return summary;
  } catch (err) {
    // Best-effort contract: swallow everything, log once.
    log.error("push.event.error", { category: event.category, eventKey: event.eventKey, ...errorContext(err) });
    return { ...none, skipped: "error" };
  }
}
