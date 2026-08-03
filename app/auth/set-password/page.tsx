import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashInviteToken, isInviteExpired } from "@/lib/staff/crew-invite";
import { SetPasswordForm } from "@/components/auth/set-password-form";

/**
 * PUBLIC crew invite landing page. The one-time token in the URL is the
 * credential (matched by hash, server-side). Never indexed. Under /auth so the
 * proxy already treats it as public.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set your password — Marley Moves",
  robots: { index: false, follow: false },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-md border bg-card p-8 shadow-sm">
        <div className="mb-8 text-center">
          <p className="eyebrow mb-2">Crew portal</p>
          <h1 className="font-display text-3xl text-foreground">
            Marley <span className="text-mm-red">Ops</span>
          </h1>
        </div>
        {children}
      </div>
    </main>
  );
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let valid = false;
  let firstName: string | null = null;
  if (token && token.length >= 20) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("profiles")
      .select("full_name, active, invite_expires_at")
      // .filter (not .eq) — the column isn't in the generated schema type yet.
      .filter("invite_token_hash", "eq", hashInviteToken(token))
      .maybeSingle();
    const p = data as unknown as { full_name: string; active: boolean; invite_expires_at: string | null } | null;
    if (p && p.active && !isInviteExpired(p.invite_expires_at)) {
      valid = true;
      firstName = (p.full_name || "").split(/\s+/)[0] || null;
    }
  }

  if (!valid || !token) {
    return (
      <Shell>
        <div className="text-center">
          <h2 className="font-brand text-xl font-semibold text-foreground">This link isn&apos;t active</h2>
          <p className="mt-3 text-sm leading-relaxed text-mist-500">
            Your invite link has expired or already been used. Ask the office to send you a fresh one, or call{" "}
            <a href="tel:01747637070" className="font-semibold text-foreground">
              01747 637070
            </a>
            .
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <SetPasswordForm token={token} firstName={firstName} />
    </Shell>
  );
}
