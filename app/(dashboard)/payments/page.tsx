import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RefreshButton } from "@/components/payments/refresh-button";
import { ReceivedTab, type ReceivedParams } from "./received-tab";
import { DueTab } from "./due-tab";
import { UpcomingTab } from "./upcoming-tab";

/**
 * Payments — the money surface, three lenses:
 *   Received   what landed, by range, with the rail (everyone in the office)
 *   Due        what's owed right now, £-totalled per stage (admins)
 *   Upcoming   expected money, next 4 Mon–Sun weeks + pencilled pot (admins)
 * Due/Upcoming are admin-only like /finance (Peter, 2026-08-16 — admins are
 * Peter, Luke and Connor). Tab state lives in the URL so views are linkable.
 */

export const dynamic = "force-dynamic";

type Tab = "received" | "due" | "upcoming";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<ReceivedParams & { tab?: string }>;
}) {
  const params = await searchParams;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { data: profile } = user
    ? await sb.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const isAdmin = profile?.role === "admin";

  // A non-admin asking for an admin tab silently gets Received — same shape as
  // /finance's redirect, without bouncing them off the page they CAN use.
  const requested = (params.tab ?? "received") as Tab;
  const tab: Tab = requested === "due" || requested === "upcoming" ? (isAdmin ? requested : "received") : "received";

  const tabs: { key: Tab; label: string }[] = [
    { key: "received", label: "Received" },
    ...(isAdmin
      ? ([
          { key: "due", label: "Due" },
          { key: "upcoming", label: "Upcoming" },
        ] as { key: Tab; label: string }[])
      : []),
  ];

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Payments">
        <RefreshButton />
      </PageHeader>

      {tabs.length > 1 ? (
        <div className="flex items-center gap-1 border-b">
          {tabs.map(({ key, label }) => (
            <Link
              key={key}
              href={key === "received" ? "/payments" : `/payments?tab=${key}`}
              aria-current={tab === key ? "page" : undefined}
              className={`focus-ring -mb-px inline-flex min-h-10 items-center border-b-2 px-4 text-sm font-semibold transition-colors ${
                tab === key
                  ? "border-mm-red text-foreground"
                  : "border-transparent text-mist-400 hover:text-foreground"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      ) : null}

      {tab === "due" ? <DueTab /> : tab === "upcoming" ? <UpcomingTab /> : <ReceivedTab params={params} />}
    </main>
  );
}
