import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { crewAssignedToAppointment } from "@/lib/job-sheet-load";

export type JobActor = {
  id: string;
  full_name: string;
  email: string | null;
  role: "admin" | "estimator" | "crew";
};

export type JobAccess = {
  actor: JobActor;
  admin: ReturnType<typeof createAdminClient>;
};

export const isOfficeJobActor = (actor: JobActor) => actor.role === "admin" || actor.role === "estimator";

/** Resolve the signed-in active profile. The role is read from the database,
 * never from client input or JWT metadata. */
export async function getActiveJobActor(): Promise<JobActor | null> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const { data: profile } = await sb
    .from("profiles")
    .select("id, full_name, email, role, active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.active) return null;
  if (profile.role !== "admin" && profile.role !== "estimator" && profile.role !== "crew") return null;

  return {
    id: profile.id,
    full_name: profile.full_name,
    email: profile.email ?? null,
    role: profile.role,
  };
}

/** Office can work on any appointment. Crew can use service-role job actions
 * only for a non-cancelled appointment to which their staff row is assigned. */
export async function requireAppointmentAccess(appointmentId: string): Promise<JobAccess | null> {
  const actor = await getActiveJobActor();
  if (!actor) return null;

  const admin = createAdminClient();
  if (isOfficeJobActor(actor)) return { actor, admin };
  if (actor.role !== "crew") return null;

  const assigned = await crewAssignedToAppointment(admin, actor.id, actor.email, appointmentId);
  return assigned ? { actor, admin } : null;
}
