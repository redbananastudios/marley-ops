import type { Metadata } from "next";
import { getSessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { OfficeManual } from "@/components/manual/office-manual";
import { EstimatorManual } from "@/components/manual/estimator-manual";
import { CrewManual } from "@/components/manual/crew-manual";
import { ManualRoleSwitcher, type ManualView } from "@/components/manual/role-switcher";

export const metadata: Metadata = { title: "User manual" };

/**
 * /manual — role-rendered training material. Every role reaches the same URL
 * and gets its own manual: estimators the estimator field guide, admins the
 * full office manual plus a preview switcher for the other two. Crew never
 * reach this route (the dashboard layout redirects them to /my-jobs); their
 * manual lives at /my-jobs/manual inside the crew chrome.
 */
export default async function ManualPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const [profile, sp] = await Promise.all([getSessionProfile(), searchParams]);
  const isAdmin = profile?.role === "admin";

  // Estimators always get their own manual; only admins may preview others.
  const view: ManualView = !isAdmin
    ? "estimator"
    : sp.view === "estimator" || sp.view === "crew"
      ? sp.view
      : "office";

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Help" title="User manual" />
      {isAdmin ? <ManualRoleSwitcher active={view} /> : null}
      {view === "office" ? <OfficeManual /> : view === "estimator" ? <EstimatorManual /> : <CrewManual />}
    </main>
  );
}
