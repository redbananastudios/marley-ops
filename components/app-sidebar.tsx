"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BellRing,
  CalendarCheck,
  CalendarRange,
  ClipboardCheck,
  Contact,
  FileCheck2,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  Settings,
  Sparkles,
  Truck,
  UserCog,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { QuickCreate } from "@/components/quick-create";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { group: string; items: NavItem[] };

const OFFICE_NAV: NavGroup[] = [
  {
    group: "Pipeline",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/follow-ups", label: "Follow-ups", icon: BellRing },
      { href: "/clients", label: "Clients", icon: Contact },
      { href: "/board", label: "Pipeline Board", icon: KanbanSquare },
    ],
  },
  {
    group: "Schedule",
    items: [
      { href: "/schedule/surveys", label: "Surveys", icon: CalendarCheck },
      { href: "/schedule/removals", label: "Removals", icon: Truck },
      { href: "/schedule/board", label: "Job Board", icon: CalendarRange },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/resources", label: "Staff & Fleet", icon: UserCog },
      { href: "/storage", label: "Storage", icon: Warehouse },
    ],
  },
  {
    group: "Sales",
    items: [
      { href: "/quotes", label: "Quotes", icon: FileText },
      { href: "/bookings", label: "Bookings", icon: ClipboardCheck },
      { href: "/documents", label: "Documents", icon: FileCheck2 },
    ],
  },
  { group: "Reports", items: [{ href: "/performance", label: "Performance", icon: BarChart3 }] },
  { group: "System", items: [{ href: "/settings", label: "Settings", icon: Settings }] },
];

const ESTIMATOR_NAV: NavGroup[] = [
  {
    group: "Your work",
    items: [
      { href: "/estimator", label: "My day", icon: Sparkles },
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/follow-ups", label: "Follow-ups", icon: BellRing },
    ],
  },
  {
    group: "Survey & quote",
    items: [
      { href: "/schedule/surveys", label: "Surveys", icon: CalendarCheck },
      { href: "/quotes", label: "Quotes", icon: FileText },
    ],
  },
];

export function navForRole(role: string): NavGroup[] {
  return role === "estimator" ? ESTIMATOR_NAV : OFFICE_NAV;
}

/** Brand lockup for the black rails: the official full-colour Marley brandmark
 *  in a clean white app-tile + the wordmark in Cormorant Garamond (the website
 *  heading face). Shared by the desktop sidebar, mobile header and drawer.
 *  The source PNG (500×500) carries whitespace padding, so the <img> is sized
 *  larger than the tile to bring the house + van up to a confident size. */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        className={cn(
          "relative shrink-0 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/[0.06]",
          compact ? "size-9" : "size-10",
        )}
      >
        {/* The mark is larger than the tile (the source PNG has whitespace
            padding); absolutely centre it — CSS grid place-items anchors an
            oversized item top-left, which pushed the mark to the bottom-right. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand-mark.png"
          alt="Marley Moves"
          className={cn(
            "absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 object-contain",
            compact ? "size-[46px]" : "size-[52px]",
          )}
        />
      </span>
      <span
        className={cn(
          "truncate font-brand font-semibold uppercase leading-none tracking-[0.03em] text-white",
          compact ? "text-[19px]" : "text-[22px]",
        )}
      >
        Marley <span className="text-mm-red-bright">Ops</span>
      </span>
    </span>
  );
}

export function SidebarNavList({
  pathname,
  role,
  onNavigate,
}: {
  pathname: string;
  role: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {navForRole(role).map((group) => (
        <div key={group.group} className="mb-5 last:mb-0">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
            {group.group}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "focus-ring relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors",
                      active
                        ? "bg-white/[0.075] text-white before:absolute before:left-0 before:top-1/2 before:h-6 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-mm-red-bright"
                        : "text-white/62 hover:bg-white/[0.055] hover:text-white",
                    )}
                  >
                    {/* Borderless plates + 16px stroke-2 icons: translucent 1px
                        borders and odd icon sizes anti-alias into mush on the
                        black rail — solid fills and pixel-grid sizes stay sharp. */}
                    <span
                      className={cn(
                        "relative grid size-7 shrink-0 place-items-center rounded-md transition-colors",
                        active
                          ? "bg-mm-red-bright/15 text-mm-red-bright"
                          : "bg-white/[0.06] text-white/60 group-hover:text-white",
                      )}
                    >
                      <Icon className="size-4" strokeWidth={2} />
                    </span>
                    {item.label}
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

export function NavFooter({ profile }: { profile: { full_name: string; role: string } }) {
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="border-t border-white/8 p-3">
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-xs font-semibold text-white">
          {(profile.full_name || "M").trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{profile.full_name}</p>
          <p className="text-xs capitalize text-white/38">{profile.role}</p>
        </div>
        <button
          onClick={signOut}
          aria-label="Sign out"
          className="focus-ring flex size-10 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <LogOut className="size-[18px]" strokeWidth={1.65} />
        </button>
      </div>
    </div>
  );
}

export function AppSidebar({ profile }: { profile: { full_name: string; role: string } }) {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar xl:flex">
      <div className="flex h-16 shrink-0 items-center px-4">
        <BrandMark />
      </div>

      <div className="px-3 pb-1 pt-1">
        <QuickCreate className="w-full" />
      </div>

      {/* min-h-0 is load-bearing: without it a flex child keeps its content
          height (min-height:auto) and the overflow never scrolls, so the last
          groups (System → Settings) fall off the bottom on short viewports. */}
      <nav className="nav-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <SidebarNavList pathname={pathname} role={profile.role} />
      </nav>

      <NavFooter profile={profile} />
    </aside>
  );
}
