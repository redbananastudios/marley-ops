"use server";

/**
 * Save a lead's move window — the ONLY writer for the `booking_details`
 * side-table (migration 0080; design doc docs/schedule-allocation-design.md).
 *
 * Captures the soft, pre-diary facts: approximate window in the customer's
 * words, target month, provisional date and the homeowner/rented date-flex
 * flag. Money is NEVER written here — deposit/25% state is owned by Payments
 * Policy v2 and only ever displayed read-only in the drawer.
 *
 * Office-gated (admin/estimator; crew rejected) and written through the AUTHED
 * client so the table's is_office() RLS is the real enforcement, not just this
 * check.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  cleanApproxWindow,
  normaliseApproxMonth,
  normaliseProvisionalDate,
  normalisePropertyType,
} from "@/lib/bookings/booking-details";

export interface SaveBookingDetailsInput {
  leadId: string;
  /** Free text, e.g. "mid-August". Empty/whitespace clears it. */
  approxWindow?: string | null;
  /** "YYYY-MM" from the month input (a stored "YYYY-MM-01" is also accepted). */
  approxMonth?: string | null;
  /** "YYYY-MM-DD" — a guessed date that stays off the diary. */
  provisionalDate?: string | null;
  propertyType?: string | null;
}

export type SaveBookingDetailsResult = { ok: true } | { ok: false; error: string };

const inputSchema = z.object({
  leadId: z.string().uuid(),
  approxWindow: z.string().max(400).nullish(),
  approxMonth: z.string().max(20).nullish(),
  provisionalDate: z.string().max(20).nullish(),
  propertyType: z.string().max(20).nullish(),
});

export async function saveBookingDetailsAction(
  input: SaveBookingDetailsInput,
): Promise<SaveBookingDetailsResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid booking details." };

  // Office only — crew never sets move windows. RLS (is_office) backs this up.
  const profile = await getSessionProfile();
  if (!profile || (profile.role !== "admin" && profile.role !== "estimator")) {
    return { ok: false, error: "Office access required." };
  }

  const month = normaliseApproxMonth(parsed.data.approxMonth);
  if (!month.ok) return { ok: false, error: month.error };
  const provisional = normaliseProvisionalDate(parsed.data.provisionalDate);
  if (!provisional.ok) return { ok: false, error: provisional.error };

  const supabase = await createClient();
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, status")
    .eq("id", parsed.data.leadId)
    .maybeSingle();
  if (leadError) return { ok: false, error: leadError.message };
  if (!lead) return { ok: false, error: "Lead not found." };
  // The writer owns its own invariant (review 2026-07-29): no move window on a
  // closed lead, even if a stale UI still offers the button.
  if (lead.status === "completed" || lead.status === "declined") {
    return { ok: false, error: "This lead is closed." };
  }

  const { error } = await supabase.from("booking_details").upsert(
    {
      lead_id: parsed.data.leadId,
      approx_window: cleanApproxWindow(parsed.data.approxWindow),
      approx_month: month.value,
      provisional_date: provisional.value,
      property_type: normalisePropertyType(parsed.data.propertyType),
    },
    { onConflict: "lead_id" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/schedule");
  revalidatePath("/bookings");
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true };
}
