/**
 * Crew job-assignment pushes (Peter, 2026-07-15): tell a crew member the
 * moment they're put on a job — or taken off one. Fired from the Job Board
 * assignment actions AFTER the assignment write commits.
 *
 * Rules:
 *  - Only staff with a linked crew login (staff.profile_id) can be notified.
 *  - Only for live, current-or-future appointments — editing history is
 *    admin housekeeping, not news.
 *  - Best-effort: never throws, never fails the assignment.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { log, errorContext } from "@/lib/log";
import { crewJobPush } from "./categories";
import { sendPushForEvent } from "./send";

export interface CrewAssignmentChange {
  appointmentId: string;
  /** staff.id values added / removed by this action (vehicles excluded). */
  assignedStaffIds?: string[];
  removedStaffIds?: string[];
  actorUserId: string | null;
  /**
   * Notify even though the appointment row now reads `cancelled`.
   *
   * The cancelled guard below exists so that admin housekeeping on dead rows
   * never pings a phone. The inside-7-day date change is the exact inverse:
   * it cancels the old appointment FIRST and the crew member's job then just
   * disappears from /my-jobs, so the cancellation IS the news. Only set this
   * where the caller itself just cancelled the row deliberately.
   */
  notifyThoughCancelled?: boolean;
}

/** UK calendar date (YYYY-MM-DD) for "is this job still ahead of us". */
function ukDay(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

export async function notifyCrewAssignmentChange(change: CrewAssignmentChange): Promise<void> {
  const assigned = change.assignedStaffIds ?? [];
  const removed = change.removedStaffIds ?? [];
  if (assigned.length === 0 && removed.length === 0) return;

  try {
    const admin = createAdminClient();

    const { data: appt } = await admin
      .from("appointments")
      .select("id, starts_at, status")
      .eq("id", change.appointmentId)
      .maybeSingle();
    if (!appt) return;
    if (appt.status === "cancelled" && !change.notifyThoughCancelled) return;
    // Past jobs: reshuffling yesterday's board must not ping anyone's phone.
    if (appt.starts_at && ukDay(new Date(appt.starts_at)) < ukDay(new Date())) return;

    const staffIds = [...new Set([...assigned, ...removed])];
    const { data: staff } = await admin
      .from("staff")
      .select("id, profile_id, is_active")
      .in("id", staffIds)
      .not("profile_id", "is", null);
    const profileByStaff = new Map(
      (staff ?? []).filter((s) => s.is_active).map((s) => [s.id, s.profile_id as string]),
    );

    for (const staffId of staffIds) {
      const userId = profileByStaff.get(staffId);
      if (!userId) continue; // no linked login — nothing to notify
      const kind = assigned.includes(staffId) ? "assigned" : "removed";
      await sendPushForEvent(
        crewJobPush({ kind, appointmentId: change.appointmentId, staffUserId: userId, startsAt: appt.starts_at }),
        { recipientUserIds: [userId], actorUserId: change.actorUserId },
      );
    }
  } catch (err) {
    log.error("push.crew_job.error", { appointmentId: change.appointmentId, ...errorContext(err) });
  }
}
