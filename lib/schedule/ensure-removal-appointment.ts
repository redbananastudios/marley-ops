/**
 * A confirmed job must exist in the diary.
 *
 * Until 2026-08-07 nothing created the removal appointment automatically — the
 * only writers were the reschedule path, the iMVE importer and the manual "Book
 * removal" dialog. A booking whose appointment was never added by hand therefore
 * left the system after the deposit: the post-move settlement sweep in
 * app/api/cron/chase/route.ts drives entirely off `appt_type='removal'`, so with
 * no row there is no auto-complete, no review request, no crew day sheet and —
 * critically — no "balance unpaid after move day" alarm. A live audit found nine
 * confirmed deposit-paid jobs (£11,451) and zero removal appointments, including
 * one that had already moved with £400 uncollected and no alert.
 *
 * This closes that by booking the diary slot when the deposit lands. It is
 * deliberately conservative: it never moves or edits an existing appointment
 * (rescheduling belongs to booking-change), never invents a date, and never
 * throws — a diary failure must not roll back a recorded payment.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BRAND } from "@/lib/brand";
import { ukInstant } from "@/lib/uk-time";
import { log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

/** Crew day: 08:00–17:00 UK wall-clock, matching the iMVE importer's shape. */
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 17;

export type EnsureRemovalResult =
  | { created: true; appointmentId: string }
  | { created: false; reason: "exists" | "no_lead" | "no_date" | "legacy" | "error" };

/**
 * Book the removal slot for a quote's lead if it has no live one yet.
 *
 * Skips legacy iMVE quotes (the importer books their slot itself and their jobs
 * are hands-off), quotes with no usable move date, and any lead that already has
 * a non-cancelled removal appointment.
 */
export async function ensureRemovalAppointment(
  sb: Sb,
  quote: {
    id: string;
    lead_id: string | null;
    client_id: string | null;
    estimator_id: string | null;
    customer_name: string | null;
    moving_date: string | null;
    source?: string | null;
  },
): Promise<EnsureRemovalResult> {
  try {
    if (!quote.lead_id) return { created: false, reason: "no_lead" };
    if (quote.source === "imve") return { created: false, reason: "legacy" };

    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(quote.moving_date ?? "");
    if (!day) return { created: false, reason: "no_date" };

    // Any live removal on the lead wins — including one booked by hand for a
    // different day. Re-dating is a deliberate act (booking-change), never a
    // side effect of money landing.
    const { data: existing, error: existingError } = await sb
      .from("appointments")
      .select("id")
      .eq("lead_id", quote.lead_id)
      .eq("appt_type", "removal")
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle();
    if (existingError) {
      log.error("schedule.ensure_removal.lookup_failed", {
        quoteId: quote.id,
        error: existingError.message,
      });
      return { created: false, reason: "error" };
    }
    if (existing) return { created: false, reason: "exists" };

    const [, y, m, d] = day;
    const startsAt = ukInstant(Number(y), Number(m), Number(d), DAY_START_HOUR, 0).toISOString();
    const endsAt = ukInstant(Number(y), Number(m), Number(d), DAY_END_HOUR, 0).toISOString();

    // The van goes to where the move starts — same derivation as the manual
    // booking dialog, so an auto-booked slot reads identically on the board.
    const { data: lead } = await sb
      .from("leads")
      .select("name, from_address, from_postcode, client_id, brand")
      .eq("id", quote.lead_id)
      .maybeSingle();
    const name = lead?.name ?? quote.customer_name ?? null;

    const { data: appt, error } = await sb
      .from("appointments")
      .insert({
        appt_type: "removal",
        // Denormalised from the parent lead at insert (PRD §3.2) — the diary
        // colours the auto-booked slot without a join.
        brand: lead?.brand ?? DEFAULT_BRAND,
        lead_id: quote.lead_id,
        client_id: quote.client_id ?? lead?.client_id ?? null,
        estimator_id: quote.estimator_id,
        title: name ? `Removal — ${name}` : "Removal",
        starts_at: startsAt,
        ends_at: endsAt,
        all_day: false,
        location: lead?.from_address || lead?.from_postcode || null,
        notes: null,
        status: "scheduled",
      } as never)
      .select("id")
      .single();

    if (error || !appt) {
      log.error("schedule.ensure_removal.insert_failed", {
        quoteId: quote.id,
        leadId: quote.lead_id,
        error: error?.message ?? "no row returned",
      });
      return { created: false, reason: "error" };
    }

    log.info("schedule.ensure_removal.booked", {
      quoteId: quote.id,
      leadId: quote.lead_id,
      appointmentId: appt.id,
      movingDate: quote.moving_date,
    });
    return { created: true, appointmentId: appt.id };
  } catch (err) {
    // Never let the diary break a money write.
    log.error("schedule.ensure_removal.threw", {
      quoteId: quote.id,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { created: false, reason: "error" };
  }
}
