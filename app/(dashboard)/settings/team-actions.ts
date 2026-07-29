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
