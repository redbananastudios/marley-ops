"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BellRing,
  CalendarCheck,
  Contact,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  Settings,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon; live: boolean };
type NavGroup = { group: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    group: "Pipeline",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard, live: true },
      { href: "/leads", label: "Leads", icon: Users, live: true },
      { href: "/follow-ups", label: "Follow-ups", icon: BellRing, live: true },
      { href: "/clients", label: "Clients", icon: Contact, live: true },
      { href: "/board", label: "Board", icon: KanbanSquare, live: true },
    ],
  },
  {
    group: "Schedule",
    items: [
      { href: "/schedule/surveys", label: "Surveys", icon: CalendarCheck, live: true },
      { href: "/schedule/removals", label: "Removals", icon: Truck, live: true },
    ],
  },
  { group: "Sales", items: [{ href: "/quotes", label: "Quotes", icon: FileText, live: true }] },
  { group: "Reports", items: [{ href: "/performance", label: "Performance", icon: BarChart3, live: true }] },
  { group: "Settings", items: [{ href: "/settings", label: "Settings", icon: Settings, live: true }] },
];

/** The grouped nav links — shared by the desktop sidebar and the mobile drawer.
    `onNavigate` lets the drawer close itself when a link is tapped. */
export function SidebarNavList({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group} className="mb-5">
          <p className="eyebrow px-2 pb-2">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              const Icon = it.icon;
              if (!it.live) {
                return (
                  <li key={it.href}>
                    <span
                      aria-disabled="true"
                      className="flex min-h-11 cursor-not-allowed items-center gap-2.5 rounded-sm px-2 py-2 text-sm text-mist-400"
                    >
                      <Icon className="size-[18px]" strokeWidth={1.75} />
                      {it.label}
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-mist-400">soon</span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    className={cn(
                      "focus-ring relative flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      active
                        ? // Modern active state: soft crimson pill + floating rounded indicator
                          // (no border-l, so nothing shifts) + the icon carries the accent.
                          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-crimson"
                        : "text-mist-500 hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn("size-[18px]", active ? "text-crimson" : "text-mist-400")}
                      strokeWidth={active ? 2 : 1.75}
                    />
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Profile + sign-out footer — shared by the sidebar and the drawer. */
export function NavFooter({ profile }: { profile: { full_name: string; role: string } }) {
  const router = useRouter();
  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <div className="border-t p-3">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{profile.full_name}</p>
          <p className="text-xs capitalize text-mist-400">{profile.role}</p>
        </div>
        <button
          onClick={signOut}
          aria-label="Sign out"
          className="focus-ring flex size-11 items-center justify-center rounded-sm text-mist-400 hover:bg-muted hover:text-foreground"
        >
          <LogOut className="size-[18px]" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export function AppSidebar({ profile }: { profile: { full_name: string; role: string } }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-16 items-center border-b px-5">
        <span className="font-display text-xl text-foreground">
          Marley <span className="text-mm-red">Ops</span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <SidebarNavList pathname={pathname} />
      </nav>

      <NavFooter profile={profile} />
    </aside>
  );
}
