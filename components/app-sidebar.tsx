"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BellRing,
  CalendarCheck,
  ClipboardCheck,
  Contact,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
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
  {
    group: "Sales",
    items: [
      { href: "/quotes", label: "Quotes", icon: FileText, live: true },
      { href: "/bookings", label: "Bookings", icon: ClipboardCheck, live: true },
    ],
  },
  { group: "Reports", items: [{ href: "/performance", label: "Performance", icon: BarChart3, live: true }] },
  { group: "Settings", items: [{ href: "/settings", label: "Settings", icon: Settings, live: true }] },
];

/** The grouped nav links — shared by the desktop sidebar and the mobile drawer.
    `onNavigate` lets the drawer close itself when a link is tapped. When
    `collapsed`, labels/eyebrows hide and icons centre in a 44px rail target
    (label survives as title + aria-label for discoverability). */
export function SidebarNavList({
  pathname,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  return (
    <>
      {NAV.map((g, gi) => (
        <div key={g.group} className={cn(collapsed ? "mb-2" : "mb-5")}>
          {collapsed ? (
            gi > 0 ? (
              <div className="mx-2 mb-2 border-t border-border" aria-hidden />
            ) : null
          ) : (
            <p className="eyebrow px-2 pb-2">{g.group}</p>
          )}
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              const Icon = it.icon;
              if (!it.live) {
                return (
                  <li key={it.href}>
                    <span
                      aria-disabled="true"
                      title={collapsed ? `${it.label} — soon` : undefined}
                      className={cn(
                        "flex min-h-11 cursor-not-allowed items-center gap-2.5 rounded-sm px-2 py-2 text-sm text-mist-400",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <Icon className="size-[18px]" strokeWidth={1.75} />
                      {collapsed ? null : (
                        <>
                          {it.label}
                          <span className="ml-auto text-[10px] uppercase tracking-wide text-mist-400">soon</span>
                        </>
                      )}
                    </span>
                  </li>
                );
              }
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    title={collapsed ? it.label : undefined}
                    aria-label={collapsed ? it.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "focus-ring relative flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      collapsed && "justify-center px-0",
                      active
                        ? // Modern active state: soft crimson pill + floating rounded indicator
                          // (no border-l, so nothing shifts) + the icon carries the accent.
                          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-crimson"
                        : "text-mist-500 hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn("size-[18px] shrink-0", active ? "text-crimson" : "text-mist-400")}
                      strokeWidth={active ? 2 : 1.75}
                    />
                    {collapsed ? null : it.label}
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

/** Profile + sign-out footer — shared by the sidebar and the drawer. Collapsed:
    just the sign-out icon (the name lives in the expanded view). */
export function NavFooter({
  profile,
  collapsed = false,
}: {
  profile: { full_name: string; role: string };
  collapsed?: boolean;
}) {
  const router = useRouter();
  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <div className={cn("border-t", collapsed ? "p-2" : "p-3")}>
      <div className={cn("flex items-center gap-2", collapsed ? "justify-center" : "px-2 py-1.5")}>
        {collapsed ? null : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{profile.full_name}</p>
            <p className="text-xs capitalize text-mist-400">{profile.role}</p>
          </div>
        )}
        <button
          onClick={signOut}
          aria-label="Sign out"
          title={collapsed ? `Sign out (${profile.full_name})` : undefined}
          className="focus-ring flex size-11 items-center justify-center rounded-sm text-mist-400 hover:bg-muted hover:text-foreground"
        >
          <LogOut className="size-[18px]" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

const COLLAPSE_STORE = "mm-sidebar-collapsed";

export function AppSidebar({ profile }: { profile: { full_name: string; role: string } }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // After mount: the device's saved preference wins; with none saved, smaller
  // tablets (< 1024px) start collapsed so content gets the width (adaptive nav —
  // the drawer still covers < 768px).
  useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_STORE);
    if (stored === "1") setCollapsed(true);
    else if (stored === "0") setCollapsed(false);
    else if (window.matchMedia("(max-width: 1023px)").matches) setCollapsed(true);
  }, []);

  function toggle() {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_STORE, c ? "0" : "1");
      return !c;
    });
  }

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
        collapsed ? "w-[68px]" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b",
          collapsed ? "justify-center px-2" : "justify-between pl-5 pr-3",
        )}
      >
        {collapsed ? null : (
          <span className="truncate font-display text-xl text-foreground">
            Marley <span className="text-mm-red">Ops</span>
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-md text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-5" strokeWidth={1.75} />
          ) : (
            <PanelLeftClose className="size-5" strokeWidth={1.75} />
          )}
        </button>
      </div>

      <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}>
        <SidebarNavList pathname={pathname} collapsed={collapsed} />
      </nav>

      <NavFooter profile={profile} collapsed={collapsed} />
    </aside>
  );
}
