import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { bankFeedConfigured } from "@/lib/bank-feed/sync";
import { listActiveBrands } from "@/lib/brand";
import { parseBrandParam, BRAND_FILTER_PARAM } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandFilter } from "@/components/brand/brand-filter";
import { Card } from "@/components/ui/card";
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

/**
 * The "are we missing anything?" strip — counts that should read zero, on
 * every tab. Missing money becomes something the page TELLS you, not
 * something you hunt for: unmatched transfers, transfers a human must
 * record, and card attempts stuck mid-flight.
 *
 * BUSINESS-WIDE AND UNFILTERED BY DESIGN (multi-brand PRD §4 Payments):
 * unexplained money is unexplained regardless of brand, so the ?brand=
 * segmented control never narrows these counts — an unmatched Pitmans
 * transfer must still alarm on a Marley-filtered view.
 */
async function loadExceptions(sb: Awaited<ReturnType<typeof createClient>>): Promise<{
  unmatched: number;
  mismatches: number;
  cardStuck: number;
  /** A read failed — the counts below are NOT trustworthy, so the strip must
   *  say it doesn't know rather than render its green all-clear. */
  unknown: boolean;
}> {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const bank = bankFeedConfigured();
  const [unmatchedRes, mismatchRes, pendingRes, reviewRes] = await Promise.all([
    bank
      ? sb
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("status", "unmatched")
          .is("matched_quote_id", null)
      : Promise.resolve({ count: 0 }),
    bank
      ? sb
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("status", "unmatched")
          .not("matched_quote_id", "is", null)
      : Promise.resolve({ count: 0 }),
    // A pending card attempt older than the reconcile sweep's 10-minute net is
    // a callback that never arrived; needs_review is an unconfirmed refund.
    sb
      .from("card_payments")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("is_test", false)
      .lt("created_at", tenMinAgo),
    sb.from("card_payments").select("id", { count: "exact", head: true }).eq("status", "needs_review"),
  ]);
  // A failed count read used to resolve to 0 and the strip then announced
  // "Nothing unexplained" — the one sentence on this page that must never be
  // guessed. Track it instead and say so.
  const unknown = [unmatchedRes, mismatchRes, pendingRes, reviewRes].some(
    (r) => "error" in r && r.error,
  );
  return {
    unmatched: unmatchedRes.count ?? 0,
    mismatches: mismatchRes.count ?? 0,
    cardStuck: (pendingRes.count ?? 0) + (reviewRes.count ?? 0),
    unknown,
  };
}

function ExceptionsStrip({
  ex,
}: {
  ex: { unmatched: number; mismatches: number; cardStuck: number; unknown: boolean };
}) {
  if (ex.unknown) {
    return (
      <Card className="flex items-center gap-2.5 border-warn/30 bg-warn-bg/40 px-5 py-3">
        <AlertTriangle className="size-4 shrink-0 text-warn" strokeWidth={2} />
        <p className="text-sm font-medium text-foreground">
          Couldn&apos;t check for unexplained money just now — reload the page. Don&apos;t read this as
          all-clear.
        </p>
      </Card>
    );
  }
  const clean = ex.unmatched === 0 && ex.mismatches === 0 && ex.cardStuck === 0;
  if (clean) {
    return (
      <Card className="flex items-center gap-2.5 border-success/30 bg-success-bg/40 px-5 py-3">
        <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={2} />
        <p className="text-sm font-medium text-success">
          Nothing unexplained — every transfer is matched and no card payment is stuck.
        </p>
      </Card>
    );
  }
  const parts: { count: number; label: string }[] = [
    { count: ex.unmatched, label: "unmatched inbound" },
    { count: ex.mismatches, label: "need a human" },
    { count: ex.cardStuck, label: "card stuck" },
  ];
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 border-warn/30 bg-warn-bg/40 px-5 py-3">
      <AlertTriangle className="size-4 shrink-0 text-warn" strokeWidth={2} />
      <p className="text-sm font-medium text-foreground">Money needing attention:</p>
      {parts
        .filter((p) => p.count > 0)
        .map((p) => (
          <Link key={p.label} href="/payments" className="text-sm font-semibold text-warn hover:underline">
            {p.count} {p.label}
          </Link>
        ))}
      <span className="ml-auto text-xs text-mist-400">queues live on the Received tab</span>
    </Card>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<ReceivedParams & { tab?: string; brand?: string }>;
}) {
  const params = await searchParams;
  const sb = await createClient();
  // Started before the auth chain (it depends on neither) so the exceptions
  // counts overlap it instead of adding a round trip to every page load.
  const exceptionsPromise = loadExceptions(sb);
  // Brand layer (multi-brand PRD §4 Payments): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1).
  const activeBrands = await listActiveBrands(sb);
  const multi = activeBrands.length > 1;
  // Fresh literal, not `params`: ReceivedParams is an interface, so the
  // intersection has no implicit index signature and won't satisfy
  // parseBrandParam's Record arm — a literal with the one key it reads does.
  const brandFilter = parseBrandParam({ brand: params.brand }, activeBrands);
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

  const exceptions = await exceptionsPromise;

  // Tab switches keep the brand filter — the segmented control's param must
  // survive the move between Received/Due/Upcoming.
  const tabHref = (key: Tab): string => {
    const qs = new URLSearchParams();
    if (key !== "received") qs.set("tab", key);
    if (brandFilter !== "all") qs.set(BRAND_FILTER_PARAM, brandFilter);
    const s = qs.toString();
    return s ? `/payments?${s}` : "/payments";
  };

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Payments">
        {/* Brand filter (multi-brand PRD §4 Payments): on Due/Upcoming the
            segmented control lives in the PageHeader; the Received tab hosts
            it in its own search row instead. */}
        {multi && tab !== "received" ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
        <RefreshButton />
      </PageHeader>

      <ExceptionsStrip ex={exceptions} />

      {tabs.length > 1 ? (
        <div className="flex items-center gap-1 border-b">
          {tabs.map(({ key, label }) => (
            <Link
              key={key}
              href={tabHref(key)}
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

      {tab === "due" ? (
        <DueTab brandFilter={brandFilter} />
      ) : tab === "upcoming" ? (
        <UpcomingTab brandFilter={brandFilter} />
      ) : (
        <ReceivedTab
          params={params}
          activeBrands={activeBrands}
          multi={multi}
          brandFilter={brandFilter}
        />
      )}
    </main>
  );
}
