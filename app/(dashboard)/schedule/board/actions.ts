"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { notifyCrewAssignmentChange } from "@/lib/push/crew";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

const setSchema = z.object({
  appointment_id: z.string().uuid(),
  staff_ids: z.array(z.string().uuid()).max(50),
  vehicle_ids: z.array(z.string().uuid()).max(50),
});

export type SetAssignmentsInput = z.infer<typeof setSchema>;

/** Replace an appointment's assignments with the given sets (the modal's Confirm).
 *  Diff-based: unchanged rows survive, removed ones delete, new ones insert.
 *  Clashes are a UI warning, never a server block — double-booking is a
 *  deliberate call the user confirms. */
export async function setAssignmentsAction(input: SetAssignmentsInput) {
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const { data: current, error: readErr } = await sb
    .from("appointment_assignments")
    .select("id, staff_id, vehicle_id")
    .eq("appointment_id", v.appointment_id);
  if (readErr) return { ok: false as const, error: readErr.message };

  const wantStaff = new Set(v.staff_ids);
  const wantVehicles = new Set(v.vehicle_ids);
  const removeIds: string[] = [];
  const removedStaffIds: string[] = [];
  for (const row of current ?? []) {
    if (row.staff_id) {
      if (wantStaff.has(row.staff_id)) wantStaff.delete(row.staff_id);
      else {
        removeIds.push(row.id);
        removedStaffIds.push(row.staff_id);
      }
    } else if (row.vehicle_id) {
      if (wantVehicles.has(row.vehicle_id)) wantVehicles.delete(row.vehicle_id);
      else removeIds.push(row.id);
    }
  }
  // wantStaff is about to be consumed by the insert list — snapshot the adds.
  const assignedStaffIds = [...wantStaff];
  const inserts = [
    ...[...wantStaff].map((id) => ({ appointment_id: v.appointment_id, staff_id: id })),
    ...[...wantVehicles].map((id) => ({ appointment_id: v.appointment_id, vehicle_id: id })),
  ];

  if (removeIds.length) {
    const { error } = await sb.from("appointment_assignments").delete().in("id", removeIds);
    if (error) return { ok: false as const, error: error.message };
  }
  if (inserts.length) {
    const { error } = await sb.from("appointment_assignments").insert(inserts);
    if (error) return { ok: false as const, error: error.message };
  }

  // Crew pushes AFTER the writes commit (best-effort — never fails the action).
  await notifyCrewAssignmentChange({
    appointmentId: v.appointment_id,
    assignedStaffIds,
    removedStaffIds,
    actorUserId: userId,
  });

  revalidatePath("/schedule/board");
  return { ok: true as const };
}

/** One-shot add (the drag-drop path). No-op if already assigned. */
export async function assignResourceAction(
  appointmentId: string,
  resource: { kind: "staff" | "vehicle"; id: string },
) {
  if (!z.string().uuid().safeParse(appointmentId).success || !z.string().uuid().safeParse(resource.id).success)
    return { ok: false as const, error: "Invalid input" };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };

  const row = {
    appointment_id: appointmentId,
    staff_id: resource.kind === "staff" ? resource.id : null,
    vehicle_id: resource.kind === "vehicle" ? resource.id : null,
  };
  const { error } = await sb.from("appointment_assignments").insert(row);
  if (error) {
    if (error.message.toLowerCase().includes("duplicate") || error.code === "23505")
      return { ok: true as const, already: true };
    return { ok: false as const, error: error.message };
  }
  if (resource.kind === "staff") {
    await notifyCrewAssignmentChange({
      appointmentId,
      assignedStaffIds: [resource.id],
      actorUserId: userId,
    });
  }
  revalidatePath("/schedule/board");
  return { ok: true as const };
}

export async function unassignAction(assignmentId: string) {
  if (!z.string().uuid().safeParse(assignmentId).success) return { ok: false as const, error: "Invalid input" };
  const { sb, userId } = await actor();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  // Read before delete — the row is the only record of WHO was unassigned.
  const { data: row } = await sb
    .from("appointment_assignments")
    .select("staff_id, appointment_id")
    .eq("id", assignmentId)
    .maybeSingle();
  const { error } = await sb.from("appointment_assignments").delete().eq("id", assignmentId);
  if (error) return { ok: false as const, error: error.message };
  if (row?.staff_id) {
    await notifyCrewAssignmentChange({
      appointmentId: row.appointment_id,
      removedStaffIds: [row.staff_id],
      actorUserId: userId,
    });
  }
  revalidatePath("/schedule/board");
  return { ok: true as const };
}
