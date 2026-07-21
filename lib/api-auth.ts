import { createClient } from "@/lib/supabase/server";

/**
 * In-route auth guard for /api handlers. The proxy (middleware) already redirects
 * unauthenticated requests to /login, but this is defense-in-depth: if the matcher
 * ever changes, routes still refuse to serve without a session.
 *
 * Returns the user id, or null when unauthenticated.
 */
export async function requireApiUser(): Promise<string | null> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user?.id ?? null;
}

/**
 * Backwards-compatible boolean guard for scheduled routes. Manual execution is
 * restricted to active office profiles; crew and inactive sessions are refused.
 */
export async function requireUserOrCronSecret(req: Request): Promise<boolean> {
  return (await requireOfficeOrCronSecret(req)) !== null;
}

/** Who a finance-cron caller is — routes gate admin-only affordances on it. */
export type CronCaller = { via: "cron" } | { via: "session"; userId: string; role: "admin" | "estimator" };

/**
 * Guard for FINANCE crons (weekly digest, bank feed): cron secret, or an
 * OFFICE session (admin/estimator via the /automations Run-now button). Crew
 * sessions are refused — these routes run on the admin client and expose the
 * money picture the crew role is RLS-walled from everywhere else.
 */
export async function requireOfficeOrCronSecret(req: Request): Promise<CronCaller | null> {
  const auth = req.headers.get("authorization") ?? "";
  for (const secret of [process.env.CRON_SECRET, process.env.SYNC_CRON_SECRET]) {
    if (secret && auth === `Bearer ${secret}`) return { via: "cron" };
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: profile } = await sb.from("profiles").select("role, active").eq("id", user.id).single();
  if (!profile?.active || (profile.role !== "admin" && profile.role !== "estimator")) return null;
  return { via: "session", userId: user.id, role: profile.role };
}
