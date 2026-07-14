import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { NewLeadAlert } from "@/components/alerts/new-lead-alert";
import { OnboardingTour } from "@/components/onboarding/tour";
import { tourForRole } from "@/components/onboarding/tours";

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
      <NewLeadAlert />
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
