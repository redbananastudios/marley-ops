/**
 * Packing days — server-side IO (shared by the reschedule action and the
 * Payments Policy v2 cancel-and-rebook path). Pure rules live in
 * lib/schedule/pack-days.ts.
 */

import { sendOpsAlert } from "@/lib/comms/dispatch";
import { shiftIsoByUkDays } from "@/lib/schedule/pack-days";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = { from: (t: string) => any };

/** Shift the lead's scheduled pack days by `deltaDays` (the removal moved), so
 *  "the day before" stays the day before. Fail-soft: a pack-shift failure never
 *  blocks the reschedule, but the office is alerted — a stranded pack day
 *  misleads both the crew and the capacity grading. */
export async function shiftPackDays(
  sb: AnyClient,
  leadId: string,
  deltaDays: number,
  excludeApptId?: string,
): Promise<void> {
  if (!deltaDays) return;
  const ukDayOf = (iso: string): string =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const todayUk = ukDayOf(new Date().toISOString());

  const { data: packs, error: fetchError } = await sb
    .from("appointments")
    .select("id, starts_at, ends_at")
    .eq("lead_id", leadId)
    .eq("appt_type", "pack")
    .eq("status", "scheduled");
  if (fetchError) {
    // The same contract as a per-row failure: never block the reschedule, but
    // a silently-stranded pack misleads crew + capacity — tell the office.
    await sendOpsAlert("Packing day did NOT follow a rescheduled move", [
      `The move was rescheduled but its packing days could not be checked (${fetchError.message}).`,
      `Check the packing day by hand on the Schedule page.`,
    ], "system");
    return;
  }

  for (const p of packs ?? []) {
    if (p.id === excludeApptId || !p.starts_at) continue;

    // A pack whose day has already passed is WORK ALREADY DONE (packs have no
    // completion flow — a performed pack just stays scheduled in the past).
    // Dragging it forward would summon crew to re-pack a packed house; leave
    // it and let the office decide whether the new date needs fresh packing.
    if (ukDayOf(p.starts_at) < todayUk) {
      await sendOpsAlert("Rescheduled move had a past packing day — not moved", [
        `The move was rescheduled but its packing day (${ukDayOf(p.starts_at)}) is already in the past, so it was treated as done and left alone.`,
        `If the new date needs packing again, add a fresh packing day from the booking's edit dialog.`,
      ], "system");
      continue;
    }

    // Never shift a pack INTO the past (a big backward reschedule): it would
    // vanish from every forward-looking surface with nobody the wiser.
    const targetStarts = shiftIsoByUkDays(p.starts_at, deltaDays);
    if (ukDayOf(targetStarts) < todayUk) {
      await sendOpsAlert("Packing day could not follow the rescheduled move", [
        `Shifting the packing day with the move would land it in the past (${ukDayOf(targetStarts)}), so it was left on ${ukDayOf(p.starts_at)}.`,
        `Pick a new packing date from the booking's edit dialog.`,
      ], "system");
      continue;
    }

    const { error } = await sb
      .from("appointments")
      .update({
        starts_at: targetStarts,
        ends_at: p.ends_at ? shiftIsoByUkDays(p.ends_at, deltaDays) : null,
      })
      .eq("id", p.id);
    if (error) {
      await sendOpsAlert("Packing day did NOT follow a rescheduled move", [
        `The move was rescheduled but its packing day could not be moved (${error.message}).`,
        `Fix the packing day by hand on the Schedule page.`,
      ], "system");
    } else {
      // New day → the night-before crew sheet re-fires for whoever is on it.
      await sb.from("appointment_assignments").update({ reminded_at: null }).eq("appointment_id", p.id);
    }
  }
}
