"use server";

/**
 * Integration health checks — on-demand (button press), never on page load, so no
 * external quota is burned by rendering Settings. Each check is fail-soft and
 * returns ok | warn | fail with a one-line detail.
 */

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function requireStaff(): Promise<boolean> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return !!user;
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    const sb = await createClient();
    const { error } = await sb.from("business_settings").select("id", { head: true, count: "exact" });
    if (error) return { name: "Supabase database", status: "fail", detail: error.message };
    return { name: "Supabase database", status: "ok", detail: "Connected, settings readable" };
  } catch (e) {
    return { name: "Supabase database", status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkStorage(): Promise<HealthCheck> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.getBucket("survey-photos");
    if (error || !data) return { name: "Survey photo storage", status: "fail", detail: error?.message ?? "Bucket missing" };
    return {
      name: "Survey photo storage",
      status: data.public ? "warn" : "ok",
      detail: data.public ? "Bucket exists but is PUBLIC — should be private" : "Private bucket present",
    };
  } catch (e) {
    return { name: "Survey photo storage", status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkResend(): Promise<HealthCheck> {
  const name = "Email (Resend)";
  const dry = process.env.COMMS_DRYRUN === "true";
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return { name, status: "fail", detail: "No Resend API key configured" };
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(8000),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      name?: string;
      data?: { name?: string; status?: string }[];
    };
    // A send-only (restricted) key can't list domains — that 401 means the key is
    // alive and correctly scoped, not broken.
    let base: string;
    if (res.ok) {
      const verified = (json.data ?? []).filter((d) => d.status === "verified").map((d) => d.name);
      base = verified.length ? `Key valid · verified: ${verified.join(", ")}` : "Key valid (no verified domain visible)";
    } else if (res.status === 401 && json.name === "restricted_api_key") {
      base = "Send-only key valid (restricted scope, as intended)";
    } else {
      return { name, status: "fail", detail: `Key rejected (HTTP ${res.status})` };
    }
    return dry
      ? { name, status: "warn", detail: `${base} — COMMS_DRYRUN is ON, sends are simulated` }
      : { name, status: "ok", detail: base };
  } catch (e) {
    return { name, status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkWebex(): Promise<HealthCheck> {
  const name = "SMS (WebEx)";
  const dry = process.env.COMMS_DRYRUN === "true";
  const key = process.env.WEBEX_API_KEY;
  const sender = process.env.WEBEX_SMS_SENDER_MARLEY_MOVES || process.env.WEBEX_SMS_SENDER;
  if (!key) return { name, status: "fail", detail: "No WebEx API key configured" };
  if (!sender) return { name, status: "fail", detail: "No WebEx sender ID configured" };
  // No cheap read endpoint — presence check only (a real send is the true test).
  const base = "Key + sender configured (not pinged — sends are the real test)";
  return dry
    ? { name, status: "warn", detail: `${base} — COMMS_DRYRUN is ON, sends are simulated` }
    : { name, status: "ok", detail: base };
}

async function checkSanity(): Promise<HealthCheck> {
  const name = "Sanity lead sync";
  const projectId = process.env.SANITY_PROJECT_ID;
  const dataset = process.env.SANITY_DATASET || "production";
  const token = process.env.SANITY_API_READ_TOKEN;
  if (!projectId || !token) return { name, status: "fail", detail: "Sanity project/token not configured" };
  try {
    const q = encodeURIComponent('count(*[_type == "quoteSubmission"])');
    const res = await fetch(`https://${projectId}.api.sanity.io/v2024-01-01/data/query/${dataset}?query=${q}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return { name, status: "fail", detail: `Query rejected (HTTP ${res.status})` };
    const json = (await res.json()) as { result?: number };
    return { name, status: "ok", detail: `Connected · ${json.result ?? 0} website submissions visible` };
  } catch (e) {
    return { name, status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkMaps(): Promise<HealthCheck> {
  const name = "Google Maps";
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { name, status: "fail", detail: "No Maps API key configured" };
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent("SP7 9PX, UK")}&region=gb&key=${key}`,
      { signal: timeout(8000), cache: "no-store" },
    );
    const json = (await res.json().catch(() => ({}))) as { status?: string; error_message?: string };
    if (json.status !== "OK") return { name, status: "fail", detail: json.error_message || `Geocode status ${json.status}` };
    return { name, status: "ok", detail: "Key valid · geocoding + directions reachable" };
  } catch (e) {
    return { name, status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkPostHog(): Promise<HealthCheck> {
  const name = "PostHog";
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const host = process.env.POSTHOG_API_HOST || "https://eu.posthog.com";
  const project = process.env.MARLEY_POSTHOG_PROJECT_ID;
  if (!key || !project) return { name, status: "warn", detail: "Not configured (dashboard funnel will be empty)" };
  try {
    const res = await fetch(`${host}/api/projects/${project}/`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return { name, status: "fail", detail: `Key rejected (HTTP ${res.status})` };
    return { name, status: "ok", detail: `Connected to project ${project}` };
  } catch (e) {
    return { name, status: "fail", detail: e instanceof Error ? e.message : "Unreachable" };
  }
}

async function checkGoogleAds(): Promise<HealthCheck> {
  const name = "Google Ads";
  const missing = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "MARLEY_GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
  ].filter((k) => !process.env[k]);
  if (missing.length) return { name, status: "warn", detail: `Missing: ${missing.join(", ")} (spend/ROAS card will be empty)` };
  return { name, status: "ok", detail: "Credentials configured (verified by the dashboard spend card)" };
}

/** Run every check in parallel. Any signed-in user may run it (read-only diagnostics). */
export async function runHealthChecks(): Promise<{ ok: boolean; checks: HealthCheck[]; ranAt: string }> {
  if (!(await requireStaff())) return { ok: false, checks: [], ranAt: new Date().toISOString() };
  const checks = await Promise.all([
    checkDatabase(),
    checkStorage(),
    checkResend(),
    checkWebex(),
    checkSanity(),
    checkMaps(),
    checkPostHog(),
    checkGoogleAds(),
  ]);
  return { ok: true, checks, ranAt: new Date().toISOString() };
}
