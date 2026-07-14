"use server";

/**
 * Web-lead alert actions (Peter, 2026-07-14 — a website enquiry must never
 * sit unseen). The dashboard poller (components/alerts/new-lead-alert.tsx)
 * calls these; the pure chime-cycle logic lives in lib/lead-alerts.ts.
 *
 * Office-only: admin/estimator see the alarm — crew are redirected out of the
 * dashboard layout anyway, but both actions gate on role for defence in depth.
 * Reads/writes run on the service role after the office check (mirrors the
 * job-notes / cubic-survey pattern), so RLS quirks can't hide a fresh lead.
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UnackedWebLead } from "@/lib/lead-alerts";

const MAX_ALERT_LEADS = 10;

/** The signed-in OFFICE profile (admin/estimator, active) or null. */
async function requireOfficeProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb.from("profiles").select("id, active, role").eq("id", user.id).single();
  if (!prof?.active) return null;
  if (prof.role !== "admin" && prof.role !== "estimator") return null;
  return prof;
}

/** Unacknowledged website leads (newest first, capped) for the alert banner. */
export async function getUnackedWebLeadsAction(): Promise<UnackedWebLead[]> {
  const prof = await requireOfficeProfile();
  if (!prof) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("leads")
    .select("id, name, created_at")
    .eq("entry_channel", "web")
    .is("web_alert_ack_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_ALERT_LEADS);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name?.trim() || "New enquiry",
    created_at: r.created_at,
  }));
}

const idsSchema = z.array(z.string().uuid()).min(1).max(100);

/** Mark web leads acknowledged (silences the alarm, hides the banner). Only
 *  touches rows still NULL so a race can't blank a fresh lead's ack twice. */
export async function ackWebLeadsAction(
  ids: string[],
): Promise<{ ok: true; acked: number } | { ok: false; error: string }> {
  const prof = await requireOfficeProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const parsed = idsSchema.safeParse(ids);
  if (!parsed.success) return { ok: false, error: "Nothing to acknowledge." };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("leads")
    .update({ web_alert_ack_at: new Date().toISOString() })
    .in("id", parsed.data)
    .is("web_alert_ack_at", null)
    .select("id");
  if (error) return { ok: false, error: "Could not acknowledge — try again." };
  return { ok: true, acked: data?.length ?? 0 };
}
