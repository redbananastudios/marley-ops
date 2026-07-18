import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, CheckCircle2 } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import { CONTRACTOR_AGREEMENT_VERSION } from "@/lib/contractor/agreement";
import { CrewAgreement } from "./crew-agreement";

export const dynamic = "force-dynamic";

export default async function CrewAgreementPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!(await isSelfBillingEnabled())) redirect("/my-jobs");

  const sb = await createClient();
  const { data: signed } = await sb
    .from("contractor_agreements")
    .select("signed_at")
    .eq("profile_id", profile.id)
    .eq("agreement_version", CONTRACTOR_AGREEMENT_VERSION)
    .maybeSingle();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 sm:px-5">
        <BrandMark compact href="/my-jobs" />
        <div className="flex items-center gap-1.5">
          <span className="hidden text-sm text-white/55 sm:block">{profile.full_name}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-4 pb-10 sm:p-5 md:p-8">
        <Link
          href="/my-jobs/pay"
          className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-mist-500 hover:text-foreground"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          My invoices
        </Link>
        <p className="eyebrow mt-3">Before you invoice</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">Contractor agreement</h1>

        {signed ? (
          <div className="mt-5 rounded-xl border border-success/30 bg-success-bg p-5">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="size-5" strokeWidth={1.75} />
              <p className="font-semibold">You&apos;ve signed the contractor agreement.</p>
            </div>
            <p className="mt-1 text-sm text-mist-500">
              Signed{" "}
              {new Date(signed.signed_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}. You&apos;re all
              set to build and submit invoices.
            </p>
            <Link
              href="/my-jobs/pay"
              className="focus-ring mt-4 inline-flex min-h-11 items-center rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
            >
              Go to My pay
            </Link>
          </div>
        ) : (
          <div className="mt-5">
            <p className="mb-4 text-sm text-mist-500">
              Please read and sign this once. It confirms you work with Marley Moves as a self-employed contractor — you only need to
              do this a single time.
            </p>
            <CrewAgreement />
          </div>
        )}
      </main>
    </div>
  );
}
