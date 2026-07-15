import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy-session";

/** Next 16 proxy (renamed middleware) — refresh session + gate auth. */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // sw.js + manifest.webmanifest must bypass the auth gate: the browser
  // fetches both without a session (SW update checks run detached from any
  // page), and a 307-to-login would break push + install (same failure class
  // as the font-307 bug). api/version is the public build stamp the update
  // banner polls — an expired session must still get JSON, not a redirect.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|api/version|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2|woff|ttf)$).*)",
  ],
};
