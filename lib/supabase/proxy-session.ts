import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session on every request and gates the app: unauthenticated
 * users are redirected to /login (except the login/auth routes themselves).
 * Called from proxy.ts (Next 16's renamed middleware).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic =
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    // Customer accept/pay page — the unguessable token IS the credential.
    path.startsWith("/q/") ||
    // Storage-agreement signing page — same token-as-credential model.
    path.startsWith("/s/") ||
    // Customer cubic-survey self-fill — same token-as-credential model.
    path.startsWith("/cv/") ||
    // Public crew sign-up — one shared tokenised link for the crew WhatsApp
    // group; the page + action re-verify the token themselves.
    path.startsWith("/join/") ||
    // Crew day sheet opened from the SMS with no login — same
    // token-as-credential model (the page reads it, noindex, stale-expires).
    path.startsWith("/sheet/") ||
    // Scheduled callers (Vercel cron / i9 tasks) authenticate with a bearer
    // secret INSIDE the route (requireUserOrCronSecret); a redirect-to-login
    // here would silently break them.
    path.startsWith("/api/cron/") ||
    path.startsWith("/api/sync/") ||
    // Provider webhooks (svix-signature verified inside the route).
    path.startsWith("/api/webhooks/") ||
    // takepayments gateway messages (SHA-512 signature verified inside each
    // route) — a redirect-to-login here would eat the payment result POST.
    // Listed EXACTLY, not by prefix, so a future /api/card/* helper isn't
    // silently exposed unauthenticated.
    path === "/api/card/callback" ||
    path === "/api/card/return" ||
    // Google Places proxies — the public crew sign-up form calls them with a
    // `jt` join-token credential; each route enforces session-or-valid-token
    // itself. Listed EXACTLY so future /api/places/* helpers stay gated.
    path === "/api/places" ||
    path === "/api/places/details";

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && path.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
