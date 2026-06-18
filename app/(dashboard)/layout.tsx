import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { AppSidebar } from "@/components/app-sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar profile={{ full_name: profile.full_name || profile.email || "User", role: profile.role }} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
