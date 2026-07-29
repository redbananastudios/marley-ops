import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { tokensMatch } from "@/lib/staff/onboard-token";
import { JoinForm } from "./join-form";

/**
 * PUBLIC crew sign-up page — ONE shared link Peter drops in the crew WhatsApp
 * group; each person fills in their own details and the office approves them
 * into Staff & Fleet. The shared unguessable token is the credential, gated by
 * the staff_onboard_enabled kill switch. Mobile-first (it is opened from
 * WhatsApp on a phone). Never indexed.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Join the Marley Moves crew",
  robots: { index: false, follow: false },
};

const LOGO_URL = "/logo.png";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-mist-50 px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Marley Moves" width={170} className="mx-auto h-auto" />
        </div>
        {children}
        <p className="mt-6 text-center text-xs leading-relaxed text-mist-400">
          Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7
          <br />
          Questions? Call{" "}
          <a href="tel:01747637070" className="font-semibold text-ink">
            01747 637070
          </a>
        </p>
      </div>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-mist-200 bg-white shadow-sm">
      {children}
    </div>
  );
}

/** Dead link — deliberately the same screen whether the token is wrong or the
 *  sign-up switch is off, so the URL gives nothing away. */
function DeadLinkCard() {
  return (
    <Shell>
      <Card>
        <div className="p-6 text-center sm:p-8">
          <h1 className="font-brand text-3xl font-semibold text-ink">
            This link isn&apos;t active
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-mist-500">
            If you were sent this to join the crew, check with the office and
            they&apos;ll send you a fresh one.
          </p>
        </div>
      </Card>
    </Shell>
  );
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const sb = createAdminClient();
  const { data } = await sb
    .from("business_settings")
    .select("staff_onboard_enabled, staff_onboard_token")
    .eq("id", true)
    .maybeSingle();

  const live =
    !!data?.staff_onboard_enabled &&
    !!data.staff_onboard_token &&
    tokensMatch(token, data.staff_onboard_token);

  if (!live) return <DeadLinkCard />;

  return (
    <Shell>
      <Card>
        <div className="p-5 sm:p-8">
          <p className="eyebrow">Marley Moves crew</p>
          <h1 className="mt-1 font-brand text-3xl font-semibold text-ink">Join the crew</h1>
          <p className="mt-2 text-sm leading-relaxed text-mist-500">
            Fill in your details below. The office checks everything over and
            adds you to the crew list, then you&apos;ll hear from them.
          </p>
          <div className="mt-5">
            <JoinForm token={token} />
          </div>
        </div>
      </Card>
    </Shell>
  );
}
