import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Banknote,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  ReceiptText,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { configuredProvider, invoiceAppUrl, listInvoices, type LedgerInvoiceListItem } from "@/lib/ledger";
import {
  addDaysIso,
  dayLabel,
  invoiceVat,
  isValidDay,
  monthStart,
  outstandingTotal,
  summariseRaised,
  ukTodayDate,
  vatOwed,
  vatQuarterFor,
  vatQuarterLabel,
} from "@/lib/finance/invoices";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

/**
 * /finance — Invoices & VAT: what the business RAISED on a given UK day (and
 * month so far), with the output-VAT position on each figure, plus everything
 * still outstanding. Reads Zoho directly, so hand-raised invoices count too —
 * this reports the BUSINESS's books, not just the panel's activity. Money
 * RECEIVED lives on /payments; this page is the other half of the ledger.
 *
 * Admin-only: Zoho data bypasses RLS, so the gate must live here, not in nav.
 */

export const dynamic = "force-dynamic";

const fmtGBP = (n: number): string =>
  "£" +
  Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-success-bg text-success" },
  sent: { label: "Awaiting payment", cls: "bg-mist-100 text-mist-500" },
  viewed: { label: "Viewed", cls: "bg-mist-100 text-mist-500" },
  partially_paid: { label: "Part-paid", cls: "bg-warn-bg text-warn" },
  overdue: { label: "Overdue", cls: "bg-danger-bg text-danger" },
  void: { label: "Void", cls: "bg-mist-100 text-mist-400" },
  draft: { label: "Draft", cls: "bg-mist-100 text-mist-400" },
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </Card>
  );
}

function InvoiceRow({ inv, ledgerName }: { inv: LedgerInvoiceListItem; ledgerName: string }) {
  const pill = STATUS_PILL[inv.status] ?? { label: inv.status, cls: "bg-mist-100 text-mist-500" };
  const dead = inv.status === "void";
  const vat = invoiceVat(inv);
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 ${dead ? "opacity-55" : ""}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {inv.customerName || "—"}
        </p>
        <p className="text-xs text-mist-400">
          {inv.invoiceNumber}
          {inv.reference ? ` · ${inv.reference}` : ""}
        </p>
      </div>
      <span className={`rounded-pill px-2.5 py-0.5 text-[11px] font-semibold ${pill.cls}`}>{pill.label}</span>
      <div className="tabular text-right text-xs text-mist-400">
        {vat > 0 ? (
          <>
            <p>net {fmtGBP(inv.total - vat)}</p>
            <p>VAT {fmtGBP(vat)}</p>
          </>
        ) : (
          <p>no VAT — pre-registration</p>
        )}
      </div>
      <span className={`tabular w-24 text-right text-sm font-semibold ${dead ? "line-through" : "text-foreground"}`}>
        {fmtGBP(inv.total)}
      </span>
      <a
        href={invoiceAppUrl(inv.invoiceId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${inv.invoiceNumber} in ${ledgerName}`}
        className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
      >
        <ExternalLink className="size-4" strokeWidth={1.75} />
      </a>
    </div>
  );
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { data: profile } = user
    ? await sb.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  // The figures come straight from Zoho (no RLS between here and the books) —
  // owner/admin eyes only.
  if (profile?.role !== "admin") redirect("/");

  const { date } = await searchParams;
  const today = ukTodayDate();
  const day = isValidDay(date) && date <= today ? date : today;
  const isToday = day === today;

  // Quarter cycle (HMRC stagger) comes from Settings — quarter-TO-DATE runs to
  // the viewed day, so browsing history shows the position as it was then.
  const settings = await getBusinessSettings(sb);
  const quarter = vatQuarterFor(day, settings.vatStaggerGroup);

  let dayInvoices: LedgerInvoiceListItem[] = [];
  let mtdInvoices: LedgerInvoiceListItem[] = [];
  let quarterInvoices: LedgerInvoiceListItem[] = [];
  let unpaidInvoices: LedgerInvoiceListItem[] = [];
  let unpaidTruncated = false;
  let mtdTruncated = false;
  let quarterTruncated = false;
  /**
   * After the ledger flips to Xero, this page reads ONLY the configured provider
   * — so a VAT quarter spanning the cutover silently drops every Zoho-raised
   * invoice in it while reporting itself complete. Worse than an empty figure:
   * the migrated open invoices ARE present, so the number looks plausible.
   *
   * The real fix is design §9's union over `ledger_invoice_archive` (the table
   * and `scripts/ledger-snapshot.mjs` both exist; nothing reads them yet). Until
   * that lands, the page must at least SAY that what it is showing is partial —
   * the same rule the row cap already follows two lines down, and the reason it
   * follows it: nobody can recover a wrong number once it has been read off the
   * screen and filed.
   */
  const provider = configuredProvider();
  const historySplit = provider !== "zoho";
  // #197 rule for every error/degrade surface below: name the ledger the
  // failure actually came from — a Xero outage reported as "Zoho" sends a
  // human into the wrong system with a clear conscience.
  const ledgerName = provider === "xero" ? "Xero" : "Zoho";
  let zohoError: string | null = null;
  try {
    const [dayL, mtdL, quarterL, unpaidL] = await Promise.all([
      listInvoices({ dateStart: day, dateEnd: day }),
      listInvoices({ dateStart: monthStart(day), dateEnd: day }),
      listInvoices({ dateStart: quarter.start, dateEnd: day }),
      listInvoices({ status: "unpaid" }),
    ]);
    dayInvoices = dayL.invoices;
    mtdInvoices = mtdL.invoices;
    quarterInvoices = quarterL.invoices;
    unpaidInvoices = unpaidL.invoices;
    unpaidTruncated = unpaidL.truncated;
    // The month/quarter windows can also hit the 2,000-row cap — surface it, or
    // an over-cap quarter silently UNDERSTATES the "authoritative" VAT/turnover.
    // (A single day can't plausibly exceed the cap, so dayL.truncated is moot.)
    mtdTruncated = mtdL.truncated;
    quarterTruncated = quarterL.truncated;
  } catch (err) {
    zohoError = err instanceof Error ? err.message : `Could not reach ${ledgerName}.`;
  }

  const daySummary = summariseRaised(dayInvoices);
  const mtdSummary = summariseRaised(mtdInvoices);
  const quarterSummary = summariseRaised(quarterInvoices);
  const owed = outstandingTotal(unpaidInvoices);
  const owedCount = unpaidInvoices.filter((i) => i.balance > 0).length;

  // What's actually OWED to HMRC per window — on the Flat Rate Scheme that's
  // flatPct × gross turnover, not the 20% charged on the documents.
  const frs = settings.vatScheme === "flat_rate";
  const pct = settings.vatFlatRatePct;
  const dayVat = vatOwed(dayInvoices, settings.vatScheme, pct);
  const mtdVat = vatOwed(mtdInvoices, settings.vatScheme, pct);
  const quarterVat = vatOwed(quarterInvoices, settings.vatScheme, pct);

  const navBtn =
    "focus-ring inline-flex size-9 items-center justify-center rounded-md border border-input bg-card text-mist-500 hover:bg-muted";

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Invoices & VAT">
        <div className="flex items-center gap-2">
          <Link href={`/finance?date=${addDaysIso(day, -1)}`} aria-label="Previous day" className={navBtn}>
            <ChevronLeft className="size-4" strokeWidth={2} />
          </Link>
          <span className="min-w-36 text-center text-sm font-semibold text-foreground">
            {isToday ? "Today" : dayLabel(day)}
          </span>
          {isToday ? (
            <span aria-hidden className={`${navBtn} pointer-events-none opacity-35`}>
              <ChevronRight className="size-4" strokeWidth={2} />
            </span>
          ) : (
            <Link href={`/finance?date=${addDaysIso(day, 1)}`} aria-label="Next day" className={navBtn}>
              <ChevronRight className="size-4" strokeWidth={2} />
            </Link>
          )}
          {!isToday ? (
            <Link href="/finance" className="ml-1 text-sm font-medium text-mm-red hover:underline">
              Today
            </Link>
          ) : null}
        </div>
      </PageHeader>

      {zohoError ? (
        <Card className="border-warn-border bg-warn-bg px-5 py-4">
          <p className="text-sm font-semibold text-warn">Couldn&apos;t load the books from {ledgerName}</p>
          <p className="mt-0.5 text-sm text-warn">{zohoError} — refresh to retry.</p>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Invoiced"
          value={fmtGBP(daySummary.gross)}
          sub={`${daySummary.count} invoice${daySummary.count === 1 ? "" : "s"} raised ${isToday ? "so far today" : "on this day"}`}
        />
        <Stat
          label={frs ? `VAT owed (FRS ${pct}%)` : "Output VAT"}
          value={fmtGBP(dayVat.owed)}
          sub={
            frs
              ? `charged ${fmtGBP(dayVat.charged)} at 20% — the difference stays in the business`
              : `on ${isToday ? "today's" : "the day's"} invoices · net ${fmtGBP(daySummary.net)}`
          }
        />
        <Stat
          label="Month so far"
          value={fmtGBP(mtdSummary.gross)}
          sub={
            /* Same split-ledger declaration as the quarter tile (fd2df91): the
               month window reads only the configured provider too, so a month
               straddling the Zoho→Xero flip is a partial figure — and a
               partial figure presented as complete looks plausible, which is
               worse than an empty one. */
            historySplit
              ? `PARTIAL — only invoices raised in the current ledger. Anything raised before the switch is not counted here`
              : mtdTruncated
              ? `first 2,000 invoices only — figure UNDERSTATES, check ${ledgerName}`
              : `owed ${fmtGBP(mtdVat.owed)}${frs ? ` (FRS ${pct}%)` : " VAT"} · ${mtdSummary.count} invoice${mtdSummary.count === 1 ? "" : "s"} this month to date`
          }
        />
        <Stat
          label="VAT quarter to date"
          value={fmtGBP(quarterVat.owed)}
          sub={
            historySplit
              ? `PARTIAL — only invoices raised in the current ledger. Anything raised before the switch is not counted here`
              : quarterTruncated
              ? `first 2,000 invoices only — VAT owed UNDERSTATES, check ${ledgerName}`
              : `${vatQuarterLabel(quarter)} · invoiced ${fmtGBP(quarterSummary.gross)}${frs ? ` · FRS ${pct}%` : ""} · cycle in Settings`
          }
        />
        <Stat
          label="Outstanding"
          value={fmtGBP(owed)}
          sub={
            unpaidTruncated
              ? `first 2,000 unpaid only — figure UNDERSTATES, check ${ledgerName}`
              : `${owedCount} unpaid invoice${owedCount === 1 ? "" : "s"} across all dates`
          }
        />
      </div>

      <Card className="p-0">
        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <ReceiptText className="size-4 text-mist-400" strokeWidth={1.75} />
          <h2 className="font-display text-lg font-semibold text-foreground">
            Invoices raised {isToday ? "today" : dayLabel(day)}
          </h2>
          <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
            {daySummary.count}
          </span>
        </div>
        {dayInvoices.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-mist-400">
            {zohoError ? "—" : "No invoices were raised on this day."}
          </p>
        ) : (
          <div className="divide-y">
            {dayInvoices.map((inv) => (
              <InvoiceRow key={inv.invoiceId} inv={inv} ledgerName={ledgerName} />
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex items-start gap-3 px-5 py-4">
          <Banknote className="mt-0.5 size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
          <div>
            <p className="text-sm font-semibold text-foreground">Money received lives in Payments</p>
            <p className="mt-0.5 text-sm text-mist-400">
              This page is what we&apos;ve BILLED; card receipts, recorded bank transfers and cash are on{" "}
              <Link href="/payments" className="font-medium text-mm-red hover:underline">
                Payments
              </Link>
              . Outstanding = the gap between the two.
            </p>
          </div>
        </Card>
        <Card className="flex items-start gap-3 border-dashed px-5 py-4">
          <Info className="mt-0.5 size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
          <div>
            <p className="text-sm font-semibold text-foreground">How the VAT figures work</p>
            <p className="mt-0.5 text-sm text-mist-400">
              {frs ? (
                <>
                  Customers are charged 20% on every invoice (the per-row figures match the Zoho
                  documents), but on the <span className="font-medium text-foreground">Flat Rate Scheme</span>{" "}
                  the business owes HMRC {pct}% of VAT-INCLUSIVE turnover instead — the difference stays
                  in the business, and input VAT on purchases isn&apos;t reclaimed (capital assets over
                  £2k excepted). Registered with effect from 1 June 2026 (VAT no. 520 2213 58) — earlier
                  invoices sit outside the scheme. Owed figures use invoice dates (basic turnover
                  method); if the accountant files on the cash method the return counts receipts
                  instead. Each card rounds its own window, so day cards can differ from the month
                  by a penny — the quarter-to-date figure is the authoritative one. The return
                  itself stays with Zoho and the accountant.
                </>
              ) : (
                <>
                  Every invoice is VAT-inclusive at the standard 20% rate, so VAT is worked out per
                  invoice (gross ÷ 6) exactly as the Zoho documents itemise it. The business is
                  VAT-registered with effect from 1 June 2026 (VAT no. 520 2213 58) — invoices dated
                  before that carry no VAT here. This tracks OUTPUT VAT day to day — VAT on purchases
                  (input VAT) and the quarterly return itself stay with Zoho and the accountant.
                </>
              )}
            </p>
          </div>
        </Card>
      </div>
    </main>
  );
}
