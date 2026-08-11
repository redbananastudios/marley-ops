/**
 * Flagging a lead whose email address we can no longer reach.
 *
 * Shared by the two paths that discover an undeliverable address, so they can
 * never drift apart:
 *  - the Resend bounce webhook (immediate, event-driven — the primary path)
 *  - the daily suppression reconcile in the chase cron (the safety net)
 *
 * The effect is deliberately identical in both: stop trusting the address, stop
 * the automated ladder (which would otherwise chase into a void and eventually
 * lapse the lead to a false "lost — no response"), and put a HUMAN call task in
 * front of the office, because the one thing we cannot do about a dead address
 * is email them about it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BounceKind } from "@/lib/comms/bounce";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface FlagInvalidEmailInput {
  leadId: string;
  clientId: string | null;
  toAddress: string;
  kind: BounceKind;
  /** Provider detail for the audit trail (bounce message, subtype, or origin). */
  detail: string;
  /** When the address became undeliverable. Defaults to now. */
  at?: string;
  /** Extra context recorded on the activity (e.g. which path found it). */
  discoveredBy?: string;
  /** Sent on the source communication row, when there is one. */
  communicationId?: string | null;
}

/**
 * Returns true when this call is what flagged the lead (so a caller can count
 * only genuinely new discoveries). An already-flagged lead is refreshed rather
 * than re-alerted: the reconcile runs daily and must not re-send the same ops
 * alert every morning for an address the office already knows about.
 */
export async function flagLeadEmailInvalid(sb: Sb, input: FlagInvalidEmailInput): Promise<boolean> {
  const at = input.at ?? new Date().toISOString();
  const nowIso = new Date().toISOString();
  const complaint = input.kind === "complaint";

  const reason = complaint
    ? "The recipient marked our email as spam."
    : `Email to ${input.toAddress} hard-bounced (${input.detail}).`;

  // Only claim the flag when it is not already set — the boolean this returns
  // drives whether the office gets alerted, so it has to mean "new to us".
  const { data: claimed, error: leadError } = await sb
    .from("leads")
    .update({ email_invalid_at: at, email_invalid_reason: reason.slice(0, 300), chase_paused: true } as never)
    .eq("id", input.leadId)
    .is("email_invalid_at", null)
    .select("id");
  if (leadError) {
    log.warn("comms.invalid_email.lead_flag_failed", { leadId: input.leadId, error: leadError.message });
  }
  const isNew = !!claimed?.length;

  const notes = complaint
    ? `${input.toAddress} marked our email as spam — stop emailing them and call instead if the job is still live.`
    : `Email to ${input.toAddress} bounced, so automatic reminders can't reach them — call to confirm the right address. (${input.detail})`;

  const { data: openTask } = await sb
    .from("follow_ups")
    .select("id")
    .eq("lead_id", input.leadId)
    .eq("reason", "custom")
    .eq("source", "email_bounced")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (!openTask) {
    const { data: lead } = await sb.from("leads").select("estimator_id").eq("id", input.leadId).maybeSingle();
    await sb.from("follow_ups").insert({
      lead_id: input.leadId,
      client_id: input.clientId,
      reason: "custom",
      status: "open",
      due_at: nowIso,
      assigned_to: lead?.estimator_id ?? null,
      source: "email_bounced",
      notes,
    } as never);
  } else {
    await sb.from("follow_ups").update({ notes, due_at: nowIso }).eq("id", openTask.id);
  }

  // The timeline entry is per-discovery, but only once: a daily reconcile that
  // appended a note every morning would bury the lead's real history.
  if (isNew) {
    await sb.from("activities").insert({
      lead_id: input.leadId,
      client_id: input.clientId,
      actor_id: null,
      type: "note",
      summary: complaint
        ? `Recipient marked our email as spam — chasing paused`
        : `Email to ${input.toAddress} bounced — chasing paused, call task raised`,
      meta: {
        communication_id: input.communicationId ?? null,
        bounce_kind: input.kind,
        auto: true,
        ...(input.discoveredBy ? { discovered_by: input.discoveredBy } : {}),
      },
    });

    await sendOpsAlert(`Email undeliverable — ${input.toAddress}`, [
      `<strong>${esc(input.toAddress)}</strong> ${complaint ? "marked our email as spam" : "bounced"}: ${esc(input.detail)}.`,
      `Chasing is paused for that lead and a call task is in Follow-ups. Their automatic reminders will not reach them until the address is corrected.`,
    ], "system").catch(() => {});
  }

  return isNew;
}
