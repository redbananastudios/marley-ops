import Link from "next/link";
import { AlertTriangle, CalendarPlus, CalendarRange, CheckCircle2, PauseCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { acceptUrlFor } from "@/lib/quote/accept-flow";
import { balanceDue } from "@/lib/quote/payments";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { BalanceInvoiceButton } from "@/components/leads/balance-invoice-button";
import { CopyLinkButton, MarkPaidButton } from "@/components/bookings/booking-actions";

/**
 * Bookings — the layer between "quote accepted" and "removal completed".
 * Three stages, one page, ordered by what needs doing:
 *
 *   AWAITING DEPOSIT  accepted online, £deposit outstanding (auto-chased d1/d3)
 *   TO BOOK           deposit paid, nothing in the removals diary yet
 *   BOOKED            in the diary — balance lifecycle (invoice → paid) lives here
 *
 * Rows leave the page when the lead completes (or is lost).
 */

export const dynamic = "force-dynamic";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** UK calendar day of a timestamptz — the Job Board buckets by Europe/London
 *  day (lib/job-board.ts), so week deep-links must use this, never the raw
 *  UTC slice (an all-day Monday move during BST is stored 23:00Z Sunday). */
const ukDayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS);
}

interface Row {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  agreed: number;
  deposit: number;
  depositPaidAt: string | null;
  depositSelfreportAt: string | null;
  acceptedAt: string | null;
  acceptToken: string | null;
  movingDate: string | null;
  chasePaused: boolean;
  depositChaseStep: number;
  balancePaidAt: string | null;
  balanceInvoiceNumber: string | null;
  balanceAmount: number;
  apptStartsAt: string | null;
  cardStatus: string | null;
}

function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="flex items-baseline gap-3 border-b px-5 py-3.5">
        <h2 className="font-display text-lg text-foreground">{title}</h2>
        <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
          {count}
        </span>
        <span className="ml-auto hidden text-xs text-mist-400 sm:block">{hint}</span>
      </div>
      {count === 0 ? (
        <p className="px-5 py-6 text-sm text-mist-400">Nothing here — all clear.</p>
      ) : (
        <div className="divide-y divide-mist-150">{children}</div>
      )}
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </Card>
  );
}

export default async function BookingsPage() {
  const sb = await createClient();
  const settings = await getBusinessSettings(sb);

  const { data: quotes } = await sb
    .from("quotes")
    .select(
      "id, quote_ref, lead_id, customer_name, agreed_price, grand_total, accepted_at, accept_token, moving_date, deposit_amount, deposit_paid_at, deposit_selfreport_at, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount",
    )
    .eq("status", "accepted")
    .not("lead_id", "is", null);

  const leadIds = [...new Set((quotes ?? []).map((q) => q.lead_id as string))];
  const [{ data: leads }, { data: appts }] = await Promise.all([
    leadIds.length
      ? sb
          .from("leads")
          .select("id, name, status, preferred_date, chase_paused, deposit_chase_step, balance_paid_at")
          .in("id", leadIds)
      : Promise.resolve({ data: [] as never[] }),
    leadIds.length
      ? sb
          .from("appointments")
          .select("lead_id, starts_at, status")
          .eq("appt_type", "removal")
          // Crew sign-off flips the appointment to 'completed' on move day —
          // the booking row must keep its move date (only cancelled drops out).
          .in("status", ["scheduled", "completed"])
          .in("lead_id", leadIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  // Latest card-payment attempt per lead → a small "did they try to pay?" chip
  // on awaiting rows (the first question on a deposit chase call).
  const { data: cardAttempts } = leadIds.length
    ? await sb
        .from("card_payments")
        .select("lead_id, status, created_at")
        .in("lead_id", leadIds)
        .in("status", ["pending", "failed", "paid", "partially_refunded", "refunded", "voided"])
        .order("created_at", { ascending: false })
    : { data: [] as { lead_id: string | null; status: string; created_at: string }[] };
  const cardStatusByLead = new Map<string, string>();
  for (const a of cardAttempts ?? []) {
    if (a.lead_id && !cardStatusByLead.has(a.lead_id)) cardStatusByLead.set(a.lead_id, a.status);
  }

  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));
  const apptByLead = new Map<string, string>();
  for (const a of appts ?? []) {
    const cur = apptByLead.get(a.lead_id as string);
    if (!cur || (a.starts_at as string) < cur) apptByLead.set(a.lead_id as string, a.starts_at as string);
  }

  // One row per lead: its most recently accepted quote drives the money.
  const rows: Row[] = [];
  const seen = new Set<string>();
  const sorted = (quotes ?? []).sort((a, b) => (b.accepted_at ?? "").localeCompare(a.accepted_at ?? ""));
  for (const q of sorted) {
    const lead = leadById.get(q.lead_id as string);
    if (!lead || seen.has(lead.id)) continue;
    if (lead.status === "completed" || lead.status === "declined") continue;
    seen.add(lead.id);
    const agreed = Number(q.agreed_price ?? q.grand_total ?? 0);
    const deposit = Number(q.deposit_amount ?? settings.defaultDeposit);
    rows.push({
      quoteId: q.id,
      quoteRef: q.quote_ref,
      leadId: lead.id,
      customer: (q.customer_name || lead.name || "Customer") as string,
      agreed,
      deposit,
      depositPaidAt: q.deposit_paid_at,
      depositSelfreportAt: q.deposit_selfreport_at,
      acceptedAt: q.accepted_at,
      acceptToken: q.accept_token,
      movingDate: (q.moving_date || lead.preferred_date) as string | null,
      chasePaused: !!lead.chase_paused,
      depositChaseStep: Number(lead.deposit_chase_step ?? 0),
      balancePaidAt: lead.balance_paid_at as string | null,
      balanceInvoiceNumber:
        q.zoho_balance_invoice_id && q.zoho_balance_invoice_id !== "pending"
          ? (q.zoho_balance_invoice_number as string | null)
          : null,
      balanceAmount: Number(q.balance_invoice_amount ?? balanceDue(agreed, deposit)),
      apptStartsAt: apptByLead.get(lead.id) ?? null,
      cardStatus: cardStatusByLead.get(lead.id) ?? null,
    });
  }

  const awaiting = rows
    .filter((r) => !r.depositPaidAt)
    .sort((a, b) => (a.acceptedAt ?? "").localeCompare(b.acceptedAt ?? ""));
  const toBook = rows
    .filter((r) => r.depositPaidAt && !r.apptStartsAt)
    .sort((a, b) => (a.depositPaidAt ?? "").localeCompare(b.depositPaidAt ?? ""));
  const booked = rows
    .filter((r) => r.depositPaidAt && r.apptStartsAt)
    .sort((a, b) => a.apptStartsAt!.localeCompare(b.apptStartsAt!));

  const balanceOutstanding = booked
    .concat(toBook)
    .filter((r) => !r.balancePaidAt)
    .reduce((s, r) => s + r.balanceAmount, 0);

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader
        eyebrow="Sales"
        title="Bookings"
      >
        <p className="text-sm text-mist-400">Accepted quotes, from deposit to move day</p>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Awaiting deposit"
          value={gbp(awaiting.reduce((s, r) => s + r.deposit, 0))}
          sub={`${awaiting.length} job${awaiting.length === 1 ? "" : "s"} · auto-chased day 1 and 3`}
        />
        <Stat label="To book" value={String(toBook.length)} sub="deposit paid, not in the diary" />
        <Stat
          label="Balance outstanding"
          value={gbp(balanceOutstanding)}
          sub="due in full before move day"
        />
      </div>

      {/* ---------------- awaiting deposit ---------------- */}
      <Section
        title="Awaiting deposit"
        hint="accepted online — locks in when the deposit lands"
        count={awaiting.length}
      >
        {awaiting.map((r) => (
          <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <Link href={`/leads/${r.leadId}`} className="font-medium text-foreground hover:underline">
                {r.customer}
              </Link>
              <p className="text-xs text-mist-400">
                {r.quoteRef} · agreed {gbp(r.agreed)} · accepted {daysAgo(r.acceptedAt)}
                {r.chasePaused ? (
                  <span className="ml-2 inline-flex items-center gap-1 text-warn">
                    <PauseCircle className="size-3" strokeWidth={2} /> chasing paused
                  </span>
                ) : r.depositChaseStep > 0 ? (
                  <span className="ml-2 text-mist-400">· reminder {r.depositChaseStep}/2 sent</span>
                ) : null}
              </p>
            </div>
            {r.depositSelfreportAt ? (
              <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
                <AlertTriangle className="size-3.5" strokeWidth={2} /> Customer says sent — check the bank
              </span>
            ) : null}
            {r.cardStatus === "pending" ? (
              <span className="rounded-pill bg-mist-100 px-2.5 py-1 text-xs font-medium text-mist-500">
                Card started
              </span>
            ) : r.cardStatus === "failed" ? (
              <span className="rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-medium text-warn">
                Card declined
              </span>
            ) : null}
            <span className="tabular text-sm font-semibold text-foreground">{gbp(r.deposit)}</span>
            {r.acceptToken ? <CopyLinkButton url={acceptUrlFor(r.acceptToken)} /> : null}
            <MarkPaidButton
              quoteId={r.quoteId}
              kind="deposit"
              amount={r.deposit}
              customerName={r.customer}
              leadId={r.leadId}
              moveDay={r.apptStartsAt ? ukDayOf(r.apptStartsAt) : null}
            />
          </div>
        ))}
      </Section>

      {/* ---------------- to book ---------------- */}
      <Section title="To book" hint="deposit paid — get it in the removals diary" count={toBook.length}>
        {toBook.map((r) => (
          <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <Link href={`/leads/${r.leadId}`} className="font-medium text-foreground hover:underline">
                {r.customer}
              </Link>
              <p className="text-xs text-mist-400">
                {r.quoteRef} · {gbp(r.agreed)} · deposit paid {daysAgo(r.depositPaidAt)} ·{" "}
                {dateLabel(r.movingDate) ? `target ${dateLabel(r.movingDate)}` : "date TBC"}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
              <CheckCircle2 className="size-3.5" strokeWidth={2} /> Deposit
            </span>
            <Link
              href={`/schedule/removals?leadId=${r.leadId}`}
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3.5 text-sm font-semibold text-white transition-colors hover:brightness-95"
            >
              <CalendarPlus className="size-4" strokeWidth={2} />
              Book removal
            </Link>
          </div>
        ))}
      </Section>

      {/* ---------------- booked ---------------- */}
      <Section title="Booked" hint="payment in full is due before move day" count={booked.length}>
        {booked.map((r) => {
          const days = daysUntil(r.apptStartsAt!);
          const soon = days <= 3 && !r.balancePaidAt && !r.balanceInvoiceNumber;
          return (
            <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <Link href={`/leads/${r.leadId}`} className="font-medium text-foreground hover:underline">
                  {r.customer}
                </Link>
                <p className="text-xs text-mist-400">
                  {r.quoteRef} · {gbp(r.agreed)} · moving {dateLabel(r.apptStartsAt)}{" "}
                  {days >= 0
                    ? `(${days === 0 ? "today" : `in ${days}d`})`
                    : r.balancePaidAt
                      ? "(done — completes automatically)"
                      : "(moved — balance outstanding)"}
                </p>
              </div>
              {days < 0 && !r.balancePaidAt ? (
                <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
                  <AlertTriangle className="size-3.5" strokeWidth={2} /> OVERDUE
                </span>
              ) : null}
              {days >= 0 ? (
                <Link
                  href={`/schedule/board?week=${ukDayOf(r.apptStartsAt!)}`}
                  className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <CalendarRange className="size-4" strokeWidth={1.75} />
                  Job Board
                </Link>
              ) : null}
              {r.balancePaidAt ? (
                <span className="inline-flex items-center gap-1 rounded-pill bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
                  <CheckCircle2 className="size-3.5" strokeWidth={2} /> Paid in full
                </span>
              ) : r.balanceInvoiceNumber ? (
                <>
                  <span className="rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
                    {r.balanceInvoiceNumber} · {gbp(r.balanceAmount)} due
                  </span>
                  <MarkPaidButton quoteId={r.quoteId} kind="balance" amount={r.balanceAmount} customerName={r.customer} />
                </>
              ) : (
                <>
                  {soon ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
                      <AlertTriangle className="size-3.5" strokeWidth={2} /> Invoice before move day
                    </span>
                  ) : (
                    <span className="text-xs text-mist-400">{gbp(r.balanceAmount)} to invoice</span>
                  )}
                  <BalanceInvoiceButton leadId={r.leadId} />
                </>
              )}
            </div>
          );
        })}
      </Section>
    </main>
  );
}
