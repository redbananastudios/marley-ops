import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { CrewManual } from "@/components/manual/crew-manual";

export const metadata: Metadata = { title: "User manual" };

/**
 * /my-jobs/manual — the crew manual inside the crew chrome. Crew are
 * redirected out of the dashboard (and so away from /manual), so their
 * manual lives on their own surface, one tap from the My jobs page. The
 * content is price-free by construction and the chrome is print-hidden so
 * it prints cleanly as a van-cab hand-out.
 */
export default async function CrewManualPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 sm:px-5 print:!hidden">
        <BrandMark compact href="/my-jobs" />
        <SignOutButton />
      </header>

      <main className="mx-auto max-w-3xl p-4 pb-12 sm:p-5 md:p-8">
        <Link
          href="/my-jobs"
          className="focus-ring mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-mist-500 hover:text-foreground print:hidden"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} />
          My jobs
        </Link>
        <CrewManual />
      </main>
    </div>
  );
}
