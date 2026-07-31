"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth";
import { likeEscape } from "@/lib/util/like";
import { createAdminClient } from "@/lib/supabase/admin";

/** Admin gate returning the caller's id (for self-lockout guards).
 *  Uses getSessionProfile so a DEACTIVATED admin (active=false) fails CLOSED —
 *  it already treats an inactive account as signed out. The prior version
 *  selected `role` only, so a deactivated admin still holding a live refresh
 *  token kept full team management on the RLS-bypassing service-role client
 *  below (and could self-reactivate). */
async function requireAdmin() {
  const profile = await getSessionProfile();
  if (!profile) return { userId: null, error: "Not signed in." as const };
  if (profile.role !== "admin") return { userId: null, error: "Only admins can manage the team." as const };
  return { userId: profile.id, error: null };
}

const createSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  fullName: z.string().trim().min(1, "Name is required"),
  role: z.enum(["admin", "estimator", "crew"]),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/** Create a login + profile (admin only). The auth trigger creates the profile row;
 *  we upsert it straight after to set the chosen name/role. */
export async function createTeamUserAction(input: z.infer<typeof createSchema>) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { error } = await requireAdmin();
  if (error) return { ok: false as const, error };

  const admin = createAdminClient();
  const v = parsed.data;
  const { data, error: cErr } = await admin.auth.admin.createUser({
    email: v.email,
    password: v.password,
    email_confirm: true,
    user_metadata: { full_name: v.fullName },
  });
  if (cErr) return { ok: false as const, error: cErr.message };

  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ id: data.user.id, email: v.email, full_name: v.fullName, role: v.role, active: true });
  if (pErr) return { ok: false as const, error: pErr.message };

  // Crew login ↔ crew record: link the Staff & Fleet row that carries this
  // email so /my-jobs resolves their assignments immediately.
  if (v.role === "crew") {
    await admin.from("staff").update({ profile_id: data.user.id }).ilike("email", likeEscape(v.email)).is("profile_id", null);
  }

  revalidatePath("/settings");
  return { ok: true as const };
}

const updateSchema = z.object({
  role: z.enum(["admin", "estimator", "crew"]).optional(),
  active: z.boolean().optional(),
  fullName: z.string().trim().min(1).optional(),
});

/** Change a user's role / active flag / name (admin only). Guards against locking
 *  yourself out: you can't demote or deactivate your own account. */
export async function updateTeamUserAction(id: string, input: z.infer<typeof updateSchema>) {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { userId, error } = await requireAdmin();
  if (error) return { ok: false as const, error };

  const v = parsed.data;
  if (id === userId && ((v.role && v.role !== "admin") || v.active === false)) {
    return { ok: false as const, error: "You can't demote or deactivate your own account." };
  }

  const admin = createAdminClient();
  const patch: Record<string, unknown> = {};
  if (v.role) patch.role = v.role;
  if (v.active != null) patch.active = v.active;
  if (v.fullName) patch.full_name = v.fullName;
  const { error: uErr } = await admin.from("profiles").update(patch as never).eq("id", id);
  if (uErr) return { ok: false as const, error: uErr.message };

  revalidatePath("/settings");
  return { ok: true as const };
}

/** Set a new password for a user (admin only) — e.g. onboarding or a forgotten login. */
export async function resetTeamPasswordAction(id: string, password: string) {
  if (typeof password !== "string" || password.length < 8) {
    return { ok: false as const, error: "Password must be at least 8 characters" };
  }
  const { error } = await requireAdmin();
  if (error) return { ok: false as const, error };

  const admin = createAdminClient();
  const { error: rErr } = await admin.auth.admin.updateUserById(id, { password });
  if (rErr) return { ok: false as const, error: rErr.message };
  return { ok: true as const };
}

/** Tables where a profile shows up as an actor / author / estimator. A HARD
 *  delete is refused if the user appears in ANY of them, because deleting the
 *  profile would strip their name off real live records (some FKs are SET NULL,
 *  which would silently blank the "who did this" on jobs, signatures, pay). Those
 *  users must be DEACTIVATED instead — that keeps the history. The NO-ACTION FKs
 *  (quotes/leads/appointments/communications/…) also backstop this at the DB
 *  layer: deleting a referenced profile raises 23503, caught below. So only a
 *  login with zero footprint (a mistake, a retired test account) is hard-deleted. */
const HISTORY_REFS: { table: string; column: string; label: string }[] = [
  { table: "quotes", column: "estimator_id", label: "quotes" },
  { table: "leads", column: "estimator_id", label: "leads" },
  { table: "appointments", column: "estimator_id", label: "diary appointments" },
  { table: "surveys", column: "estimator_id", label: "surveys" },
  { table: "cubic_surveys", column: "created_by", label: "video surveys" },
  { table: "communications", column: "sent_by", label: "sent emails" },
  { table: "signatures", column: "collected_by", label: "collected signatures" },
  { table: "job_completions", column: "completed_by", label: "completed jobs" },
  { table: "job_notes", column: "author_id", label: "job notes" },
  { table: "staff_statements", column: "created_by", label: "pay statements" },
  { table: "estimator_payouts", column: "estimator_id", label: "estimator payouts" },
  { table: "claims", column: "opened_by", label: "claims" },
  { table: "refund_queue", column: "determined_by", label: "refund decisions" },
  { table: "card_payments", column: "refunded_by", label: "processed refunds" },
];

/** First table (if any) where this profile has left a footprint. A query error
 *  (renamed table/col) is treated as clean here — the DB FK backstop still
 *  protects the NO-ACTION references below. */
async function firstHistoryRef(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<string | null> {
  const hits = await Promise.all(
    HISTORY_REFS.map(async (r) => {
      const { count, error } = await admin
        .from(r.table as never)
        .select("*", { count: "exact", head: true })
        .eq(r.column as never, id);
      return !error && (count ?? 0) > 0 ? r.label : null;
    }),
  );
  return hits.find(Boolean) ?? null;
}

/** Permanently remove a login (admin only). Refuses to delete yourself, the last
 *  admin, or any user who has history in the system — those must be Deactivated
 *  so their footprint on quotes/jobs/emails stays intact. Only an unused login
 *  (a mistake or a retired test account) is actually hard-deleted. */
export async function deleteTeamUserAction(id: string) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    return { ok: false as const, error: "Invalid user id" };
  }
  const { userId, error } = await requireAdmin();
  if (error) return { ok: false as const, error };
  if (id === userId) return { ok: false as const, error: "You can't delete your own account." };

  const admin = createAdminClient();

  const { data: target } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", id)
    .maybeSingle();
  if (!target) return { ok: false as const, error: "That user no longer exists." };
  const who = (target.full_name as string) || "This user";

  // Never leave the business unable to sign in as an admin.
  if (target.role === "admin") {
    const { count } = await admin
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) <= 1) return { ok: false as const, error: "You can't delete the last admin account." };
  }

  const ref = await firstHistoryRef(admin, id);
  if (ref) {
    return {
      ok: false as const,
      error: `${who} has ${ref} on record — deactivate them instead so their history stays intact.`,
    };
  }

  // Unlink any Staff & Fleet row first (that FK is NO-ACTION and would otherwise
  // block the delete). The staff record itself is kept — only the login goes.
  await admin.from("staff").update({ profile_id: null } as never).eq("profile_id", id);

  // Delete the profile first so any reference we didn't pre-check surfaces as a
  // clean FK error (23503) rather than a half-done delete.
  const { error: pErr } = await admin.from("profiles").delete().eq("id", id);
  if (pErr) {
    const referenced = pErr.code === "23503" || /foreign key/i.test(pErr.message);
    return {
      ok: false as const,
      error: referenced
        ? `${who} still has activity on record — deactivate them instead.`
        : pErr.message,
    };
  }

  const { error: aErr } = await admin.auth.admin.deleteUser(id);
  if (aErr) {
    return { ok: false as const, error: `Profile removed but the login could not be deleted: ${aErr.message}` };
  }

  revalidatePath("/settings");
  return { ok: true as const };
}
