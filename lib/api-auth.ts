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
 * Guard for routes that a scheduled job may also call (e.g. a Vercel cron hitting
 * the Sanity sync). Accepts EITHER a signed-in session OR `Authorization: Bearer
 * <SYNC_CRON_SECRET>` when that env var is set.
 */
export async function requireUserOrCronSecret(req: Request): Promise<boolean> {
  const secret = process.env.SYNC_CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === `Bearer ${secret}`) return true;
  }
  return (await requireApiUser()) !== null;
}
