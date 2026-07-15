import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { NewLeadAlert } from "@/components/alerts/new-lead-alert";
import { PushSwRegister } from "@/components/push/sw-register";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { PullToRefresh } from "@/components/pwa/pull-to-refresh";
import { OnboardingTour } from "@/components/onboarding/tour";
import { tourForRole } from "@/components/onboarding/tours";
import { CommandPalette } from "@/components/search/command-palette";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  // Crew logins get their own surface — never the office dashboard.
  if (profile.role === "crew") redirect("/my-jobs");

  const navProfile = {
    full_name: profile.full_name || profile.email || "User",
    role: profile.role,
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Keep the push service worker registered (never prompts — enabling
          happens in Settings › Notifications). */}
      <PushSwRegister />
      {/* Deploy-freshness banner + installed-app pull-to-refresh. */}
      <UpdateBanner />
      <PullToRefresh />
      <NewLeadAlert />
      {/* Office-only quick search (Cmd/Ctrl-K). Crew are redirected above, so
          mounting here keeps it off the crew surface. */}
      <CommandPalette />
      {/* Role-scoped: estimators get their own tour — never admin-only surfaces. */}
      <OnboardingTour tour={tourForRole(profile.role)} role={profile.role} />
      <AppSidebar profile={navProfile} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav profile={navProfile} />
        {children}
      </div>
    </div>
  );
}
