"use server";

/**
 * Web Push server actions — subscription lifecycle, preferences, admin kill
 * switches and the admin self-test send. Open to every ACTIVE profile: office
 * users enable in Settings, crew enable from /my-jobs (their job-assignment
 * category). Each user only ever sees/toggles the categories their role can
 * receive.
 *
 * Ownership rules (PRD §13.2): the subscription owner is ALWAYS the signed-in
 * session — never a client-supplied id. One active owner per endpoint: if a
 * different user enables notifications on the same browser, the row transfers
 * to them (Peter's shared-device policy 2026-07-15: logout does NOT revoke;
 * the device notifies whoever last enabled it).
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { log, errorContext } from "@/lib/log";
import {
  PUSH_CATEGORIES,
  PUSH_CATEGORY_IDS,
  isPushCategoryId,
  type PushCategoryId,
} from "@/lib/push/categories";
import { endpointHash, getPushFlags, sendPushForEvent } from "@/lib/push/send";
import { vapidConfigured, vapidPublicKey } from "@/lib/push/transport";

async function requireActiveProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb
    .from("profiles")
    .select("id, active, role")
    .eq("id", user.id)
    .single();
  if (!prof?.active) return null;
  return prof;
}

/* ------------------------------------------------------------------ config */

export interface PushConfig {
  /** System is configured (VAPID keys) AND switched on in Settings. */
  enabled: boolean;
  configured: boolean;
  vapidPublicKey: string | null;
  categories: { id: PushCategoryId; label: string; description: string; enabled: boolean }[];
  /** Admin-only view of the business-wide kill switches. */
  flags: { enabled: boolean; categories: Record<PushCategoryId, boolean> } | null;
}

export async function getPushConfigAction(): Promise<PushConfig | null> {
  const prof = await requireActiveProfile();
  if (!prof) return null;
  const admin = createAdminClient();
  const flags = await getPushFlags(admin);

  const { data: prefRow } = await admin
    .from("push_preferences")
    .select("categories")
    .eq("user_id", prof.id)
    .maybeSingle();
  const prefs = (prefRow?.categories ?? {}) as Record<string, unknown>;

  return {
    enabled: vapidConfigured() && flags.enabled,
    configured: vapidConfigured(),
    vapidPublicKey: vapidPublicKey(),
    // Only the categories this role can actually receive — crew see job
    // assignments, office see enquiries + payments.
    categories: PUSH_CATEGORY_IDS.filter((id) =>
      (PUSH_CATEGORIES[id].audience as readonly string[]).includes(prof.role),
    ).map((id) => ({
      id,
      label: PUSH_CATEGORIES[id].label,
      description: PUSH_CATEGORIES[id].description,
      enabled:
        typeof prefs[id] === "boolean" ? (prefs[id] as boolean) : PUSH_CATEGORIES[id].defaultEnabled,
    })),
    flags: prof.role === "admin" ? flags : null,
  };
}

/* ------------------------------------------------------------ subscription */

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).startsWith("https://"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(512),
    auth: z.string().min(8).max(512),
  }),
  installationId: z.string().uuid(),
});

export async function saveSubscriptionAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid subscription." };
  const sub = parsed.data;

  try {
    const admin = createAdminClient();
    const hash = endpointHash(sub.endpoint);
    const now = new Date().toISOString();
    const row = {
      user_id: prof.id, // session-derived — never trust a client-sent id
      endpoint: sub.endpoint,
      endpoint_hash: hash,
      p256dh: sub.keys.p256dh,
      auth_secret: sub.keys.auth,
      expiration_time: sub.expirationTime ? new Date(sub.expirationTime).toISOString() : null,
      installation_id: sub.installationId,
      status: "active",
      last_seen_at: now,
      updated_at: now,
      revoked_at: null,
    };

    // Upsert on the unique endpoint fingerprint. If the endpoint previously
    // belonged to another user, ownership transfers here — a browser endpoint
    // has exactly one active owner (PRD §13.2).
    const { error } = await admin
      .from("push_subscriptions")
      .upsert(row, { onConflict: "endpoint_hash" });
    if (error) throw error;

    log.info("push.subscription.saved", { user: prof.id, endpoint: hash.slice(0, 12) });
    return { ok: true };
  } catch (err) {
    log.error("push.subscription.save_failed", errorContext(err));
    return { ok: false, error: "Could not register this device — try again." };
  }
}

const removeSchema = z.object({ endpoint: z.string().url().max(2048) });

/** Disable on THIS device: revoke the server record (idempotent, ownership-
 *  scoped — you can only revoke a subscription you own). */
export async function removeSubscriptionAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const admin = createAdminClient();
    const now = new Date().toISOString();
    await admin
      .from("push_subscriptions")
      .update({ status: "revoked", revoked_at: now, updated_at: now })
      .eq("endpoint_hash", endpointHash(parsed.data.endpoint))
      .eq("user_id", prof.id);
    return { ok: true };
  } catch (err) {
    log.error("push.subscription.remove_failed", errorContext(err));
    return { ok: false, error: "Could not disable — try again." };
  }
}

/** Startup reconciliation (PRD §16.3): the browser still holds a subscription —
 *  make sure the server does too (repairs drift after a prune/restore). */
export async function reconcileSubscriptionAction(
  input: unknown,
): Promise<{ ok: boolean }> {
  const res = await saveSubscriptionAction(input);
  return { ok: res.ok };
}

/* ------------------------------------------------------------- preferences */

const prefsSchema = z.record(z.string(), z.boolean());

export async function setPushPreferencesAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid preferences." };
  // Reject unknown categories outright (PRD §13.4).
  const entries = Object.entries(parsed.data);
  if (entries.length === 0 || entries.some(([k]) => !isPushCategoryId(k))) {
    return { ok: false, error: "Unknown notification category." };
  }

  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("push_preferences")
      .select("categories")
      .eq("user_id", prof.id)
      .maybeSingle();
    const merged = { ...((existing?.categories ?? {}) as Record<string, boolean>), ...parsed.data };
    const { error } = await admin
      .from("push_preferences")
      .upsert(
        { user_id: prof.id, categories: merged, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    log.error("push.preferences.save_failed", errorContext(err));
    return { ok: false, error: "Could not save preferences — try again." };
  }
}

/* ---------------------------------------------------- admin kill switches */

const flagsSchema = z.object({
  enabled: z.boolean().optional(),
  new_enquiry: z.boolean().optional(),
  payment_event: z.boolean().optional(),
  crew_job: z.boolean().optional(),
});

/** Business-wide kill switches (admin only) — flip without a deploy. */
export async function setPushFlagsAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prof = await requireActiveProfile();
  if (!prof || prof.role !== "admin") return { ok: false, error: "Admins only." };
  const parsed = flagsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid flags." };

  const patch: Database["public"]["Tables"]["business_settings"]["Update"] = {};
  if (typeof parsed.data.enabled === "boolean") patch.push_enabled = parsed.data.enabled;
  if (typeof parsed.data.new_enquiry === "boolean") patch.push_new_enquiry_enabled = parsed.data.new_enquiry;
  if (typeof parsed.data.payment_event === "boolean") patch.push_payment_event_enabled = parsed.data.payment_event;
  if (typeof parsed.data.crew_job === "boolean") patch.push_crew_job_enabled = parsed.data.crew_job;
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing to change." };

  try {
    const admin = createAdminClient();
    const { error } = await admin.from("business_settings").update(patch).eq("id", true);
    if (error) throw error;
    log.info("push.flags.updated", { by: prof.id, ...patch });
    return { ok: true };
  } catch (err) {
    log.error("push.flags.update_failed", errorContext(err));
    return { ok: false, error: "Could not update — try again." };
  }
}

/* ---------------------------------------------------------------- test send */

// In-memory rate limit (single long-lived container): 3 test sends per user
// per 10 minutes. Resets on restart — acceptable for an admin-only self-test.
const testSends = new Map<string, number[]>();
const TEST_WINDOW_MS = 10 * 60_000;
const TEST_MAX_PER_WINDOW = 3;

/** Admin-only, SELF-targeting test notification with fixed content (PRD
 *  §13.5) — proves the whole chain: VAPID → push service → SW → click. */
export async function sendTestPushAction(): Promise<
  { ok: true; accepted: number; attempted: number } | { ok: false; error: string }
> {
  const prof = await requireActiveProfile();
  if (!prof || prof.role !== "admin") return { ok: false, error: "Admins only." };

  const now = Date.now();
  const recent = (testSends.get(prof.id) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_MAX_PER_WINDOW) {
    return { ok: false, error: "Too many test notifications — try again in a few minutes." };
  }
  recent.push(now);
  testSends.set(prof.id, recent);

  const summary = await sendPushForEvent(
    {
      category: "payment_event", // normal-urgency transport settings
      eventKey: `test-${prof.id}-${now}`,
      title: "Test notification",
      body: "Push notifications are working on this device.",
      url: "/settings",
    },
    { onlyUserId: prof.id, isTest: true },
  );
  if (summary.skipped === "disabled") return { ok: false, error: "Notifications are switched off in Settings." };
  if (summary.skipped === "unconfigured") return { ok: false, error: "Push is not configured on the server." };
  if (summary.attempted === 0) return { ok: false, error: "No enabled devices found for your account." };
  return { ok: true, accepted: summary.accepted, attempted: summary.attempted };
}
