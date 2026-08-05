import type { Metadata } from "next";
import { CalendarCheck2, CheckCircle2, PhoneCall, ShieldCheck } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureCommitmentInvoice,
  ensureDepositInvoice,
  fetchQuoteByToken,
  syncZohoPayments,
  type AcceptQuoteRow,
} from "@/lib/quote/accept-flow";
import { isAcceptExpired, moveDateLabel } from "@/lib/quote/payments";
import { requestedDeposit } from "@/lib/payments-policy";
import { cardPaymentsAvailable } from "@/lib/payments/card-payments";
import { BANK_DETAILS } from "@/lib/comms/payment-email";
import { DateConfirmCard } from "@/components/quote/date-confirm-card";
import { AcceptForm } from "./accept-form";
import { DeclineOption, DepositSentButton } from "./customer-actions";
import { PayCardButton } from "./pay-card-button";

const TERMS_URL = "https://marleymoves.co.uk/terms-conditions/";

/**
 * PUBLIC customer page — linked from the quote email CTA, the PDF QR codes and
 * SMS. One URL for the whole journey: accept → pay deposit → confirmed.
 * The unguessable token is the credential; anything else 404-shapes to the
 * friendly not-found card. Never indexed.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your quote — Marley Moves",
  robots: { index: false, follow: false },
};

// Local asset — these pages used to pull the logo from the separate quotes-app
// domain; serve it from this app so the customer surface has no cross-app dep.
const LOGO_URL = "/logo.png";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function firstLine(addr: string | null): string {
  if (!addr) return "—";
  return addr.split(",")[0].trim() || "—";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-mist-50 px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Marley Moves" width={170} className="mx-auto h-auto" />
        </div>
        {children}
        <p className="mt-6 text-center text-xs leading-relaxed text-mist-400">
          Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7
          <br />
          Questions? Call{" "}
          <a href="tel:01747637070" className="font-semibold text-ink">
            01747 637070
          </a>
        </p>
      </div>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-mist-200 bg-white shadow-sm">
      {children}
    </div>
  );
}

function NotFoundCard() {
  return (
    <Shell>
      <Card>
        <div className="p-6 text-center sm:p-8">
          <h1 className="font-brand text-3xl font-semibold text-ink">
            We can&apos;t find that quote
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-mist-500">
            This link is no longer valid. If you were expecting to see your removal quote, call us
            on <strong className="text-ink">01747 637070</strong> and we&apos;ll sort it straight
            away.
          </p>
        </div>
      </Card>
    </Shell>
  );
}

function SummaryRows({ quote }: { quote: AcceptQuoteRow }) {
  const rows: [string, string][] = [
    ["Quote", quote.quote_ref],
    ["Moving from", firstLine(quote.collect_addr)],
    ["Moving to", firstLine(quote.dest_addr)],
  ];
  const when = moveDateLabel(quote.moving_date);
  if (when) rows.push(["Move date", when]);
  return (
    <dl className="divide-y divide-mist-150 border-y border-mist-150">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400">
            {k}
          </dt>
          <dd className="text-right text-sm font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BankPanel({ reference }: { reference: string }) {
  const row = (l: string, v: string, red = false) => (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400">
        {l}
      </span>
      <span className={`text-sm font-semibold ${red ? "text-mm-red" : "text-ink"}`}>{v}</span>
    </div>
  );
  return (
    <div className="rounded-md bg-mist-100 p-4">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-mist-500">
        Pay by bank transfer
      </p>
      <div className="divide-y divide-mist-200">
        {row("Account name", BANK_DETAILS.name)}
        {row("Sort code", BANK_DETAILS.sortCode)}
        {row("Account number", BANK_DETAILS.account)}
        {row("Reference", reference, true)}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mist-400">
        Please use the reference exactly as shown so we can match your payment. We&apos;ll email
        your confirmation as soon as it lands.
      </p>
    </div>
  );
}

export default async function AcceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ card?: string }>;
}) {
  const { token } = await params;
  const { card: cardResult } = await searchParams;
  const sb = createAdminClient();
  let quote = await fetchQuoteByToken(sb, token);

  // Customer declined from this page — acknowledge, don't 404 them.
  if (quote?.status === "rejected" && quote.declined_at) {
    return (
      <Shell>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">Thanks for letting us know</h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              We&apos;ve closed the quote and you won&apos;t get any more reminders from us. If
              anything changes, call <strong className="text-ink">01747 637070</strong> and
              we&apos;ll pick it straight back up. All the best with the move.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  // Only quotes the customer was actually sent (or has accepted) resolve here.
  if (!quote || (quote.status !== "sent" && quote.status !== "accepted")) return <NotFoundCard />;

  // A cancelled booking's emailed link must never solicit payment (its unpaid
  // invoices were voided) or offer date confirmation — booking_cancelled_at is
  // stamped by the Marley-cancel and mark-lost unwinds and cleared on reopen.
  if (quote.status === "accepted" && quote.booking_cancelled_at) {
    return (
      <Shell>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">
              This booking has been cancelled
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              There&apos;s nothing to pay on this page. If anything you&apos;ve paid is due back
              to you, it&apos;s being processed and we&apos;ll confirm by email. Any questions —
              or if you&apos;d like to rebook — call{" "}
              <strong className="text-ink">01747 637070</strong>.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  if (quote.status === "sent" && isAcceptExpired(quote.email_sent_at, quote.created_at)) {
    return (
      <Shell>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">This quote has expired</h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              Quotes are valid for 30 days. Prices may have changed, so give us a quick call on{" "}
              <strong className="text-ink">01747 637070</strong> and we&apos;ll refresh it for you.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  const total = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  // Pre-accept, the ask is computed live (a move inside 7 days takes the full
  // 25% up-front — late-booking collapse); once accepted, deposit_amount is
  // the frozen truth every money surface reads.
  const deposit =
    quote.status === "sent"
      ? requestedDeposit(total, quote.deposit_amount ?? 100, quote.moving_date)
      : (quote.deposit_amount ?? 100);

  /* ---------------------------------------------------------- sent → accept */
  if (quote.status === "sent") {
    return (
      <Shell>
        <Card>
          <div className="border-b border-mist-150 bg-charcoal px-6 py-5 sm:px-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-mist-300">
              Your removal quote
            </p>
            <p className="mt-1 font-display text-3xl font-bold tracking-tight text-white">
              {gbp(total)}
              <span className="ml-2 text-sm font-normal text-mist-300">
                {quote.vat_enabled ? "including VAT" : "total"}
              </span>
            </p>
          </div>
          <div className="space-y-5 p-6 sm:p-8">
            <h1 className="font-brand text-2xl font-semibold text-ink">
              {quote.customer_name ? `Ready when you are, ${quote.customer_name.split(/\s+/)[0]}.` : "Ready when you are."}
            </h1>
            <SummaryRows quote={quote} />
            <div className="flex items-start gap-3 rounded-md border border-mist-200 bg-mist-50 p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
              <p className="text-sm leading-relaxed text-mist-500">
                Accepting reserves your date. A{" "}
                <strong className="text-ink">{gbp(deposit)} deposit</strong> secures the booking —
                pay by card or bank transfer on the next screen. The balance is due before move
                day. Read our{" "}
                <a
                  href={TERMS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-ink underline underline-offset-2"
                >
                  terms &amp; conditions
                </a>
                .
              </p>
            </div>
            <AcceptForm token={token} depositLabel={gbp(deposit)} />
            <DeclineOption token={token} />
          </div>
        </Card>
      </Shell>
    );
  }

  /* ------------------------------------------------- accepted → pay / done */
  // Self-heal a missing deposit invoice, then pick up any card payment made
  // since the last visit (instant confirmation when they return from Zoho).
  if (!quote.deposit_paid_at) {
    quote = (await ensureDepositInvoice(sb, quote.id)) ?? quote;
    quote = await syncZohoPayments(sb, quote);
  }

  if (quote.deposit_paid_at) {
    // Date-confirmation state (Payments Policy v2 §5A) lives on the LEAD —
    // null = deposit still fully refundable, so the confirm card shows.
    let dateConfirmedAt: string | null = null;
    if (quote.lead_id) {
      const { data: lead } = await sb
        .from("leads")
        .select("date_confirmed_at")
        .eq("id", quote.lead_id)
        .maybeSingle();
      dateConfirmedAt = lead?.date_confirmed_at ?? null;
    }
    if (dateConfirmedAt) {
      // Self-heal a missing commitment invoice (a prior partial failure) and
      // pick up a commitment payment recorded in Zoho since the last visit.
      quote = (await ensureCommitmentInvoice(sb, quote.id)) ?? quote;
      if (quote.zoho_commitment_invoice_id && !quote.commitment_paid_at) {
        quote = await syncZohoPayments(sb, quote);
      }
    }

    const moveLbl = moveDateLabel(quote.moving_date);
    const commitAmt = Number(quote.commitment_invoice_amount ?? 0);
    const commitDueLbl = moveDateLabel(quote.commitment_due_date);
    const showConfirmCard = !dateConfirmedAt && !!moveLbl && !!quote.lead_id;

    return (
      <Shell>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <CheckCircle2 className="mx-auto size-12 text-success" strokeWidth={1.5} />
            <h1 className="mt-4 font-brand text-3xl font-semibold text-ink">
              You&apos;re booked in
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              Your {gbp(deposit)} deposit is received and your move
              {moveLbl ? (
                <>
                  {" "}
                  on <strong className="text-ink">{moveLbl}</strong>
                </>
              ) : null}{" "}
              is secured. We&apos;ve emailed your confirmation — the remaining balance is due
              before move day and we&apos;ll send the final invoice nearer the time.
            </p>
          </div>
        </Card>

        {showConfirmCard ? (
          <div className="mt-6">
            <Card>
              <div className="p-6 sm:p-8">
                <DateConfirmCard token={token} moveDateLabel={moveLbl!} />
              </div>
            </Card>
          </div>
        ) : null}

        {dateConfirmedAt ? (
          <div className="mt-6">
            <Card>
              <div className="space-y-5 p-6 sm:p-8">
                <div className="flex items-start gap-3">
                  <CalendarCheck2 className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.75} />
                  <div>
                    <h2 className="font-brand text-xl font-semibold text-ink">
                      Move date confirmed
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-mist-500">
                      {moveLbl ? (
                        <>
                          Your move on <strong className="text-ink">{moveLbl}</strong> is
                          confirmed.{" "}
                        </>
                      ) : null}
                      Your deposit is held against your booking and counts towards your final
                      bill.
                    </p>
                  </div>
                </div>

                {commitAmt > 0 && !quote.commitment_paid_at ? (
                  <>
                    <p className="text-sm leading-relaxed text-mist-500">
                      Your commitment payment of{" "}
                      <strong className="text-ink">{gbp(commitAmt)}</strong> is{" "}
                      {commitDueLbl ? (
                        <>
                          due by <strong className="text-ink">{commitDueLbl}</strong>
                        </>
                      ) : (
                        "due now"
                      )}
                      . It counts towards your final bill.
                    </p>
                    <BankPanel reference={quote.quote_ref} />
                    {quote.zoho_commitment_invoice_number && quote.zoho_commitment_invoice_url ? (
                      <p className="text-center text-xs text-mist-400">
                        Your commitment invoice{" "}
                        <a
                          href={quote.zoho_commitment_invoice_url}
                          className="font-semibold text-ink underline underline-offset-2"
                        >
                          {quote.zoho_commitment_invoice_number}
                        </a>{" "}
                        is ready to view.
                      </p>
                    ) : null}
                  </>
                ) : commitAmt > 0 && quote.commitment_paid_at ? (
                  <p className="text-sm leading-relaxed text-mist-500">
                    Your {gbp(commitAmt)} commitment payment is received — thank you. The
                    remaining balance is due in full before move day.
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-mist-500">
                    Your deposit already covers the commitment for your booking, so there is
                    nothing more to pay right now. The remaining balance is due in full before
                    move day.
                  </p>
                )}
              </div>
            </Card>
          </div>
        ) : null}
      </Shell>
    );
  }

  // Card via takepayments — env creds + the Settings kill switch, both on.
  const cardOk = await cardPaymentsAvailable(sb).catch(() => false);

  return (
    <Shell>
      <Card>
        <div className="border-b border-mist-150 bg-charcoal px-6 py-5 sm:px-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-mist-300">
            Quote accepted — one last step
          </p>
          <p className="mt-1 font-display text-3xl font-bold tracking-tight text-white">
            {gbp(deposit)}
            <span className="ml-2 text-sm font-normal text-mist-300">deposit to secure your date</span>
          </p>
        </div>
        <div className="space-y-5 p-6 sm:p-8">
          {cardResult === "failed" ? (
            <div className="rounded-md border border-warn-border bg-warn-bg p-4">
              <p className="text-sm font-semibold text-ink">
                Your card payment didn&apos;t complete — no money has been taken.
              </p>
              <p className="mt-1 text-sm leading-relaxed text-mist-500">
                {cardOk ? "You can try again below, or pay by bank transfer instead." : "Please pay by bank transfer below."}{" "}
                If it keeps happening, call us on <strong className="text-ink">01747 637070</strong>{" "}
                and we&apos;ll sort it together.
              </p>
            </div>
          ) : cardResult === "error" ? (
            <div className="rounded-md border border-warn-border bg-warn-bg p-4">
              <p className="text-sm font-semibold text-ink">
                We couldn&apos;t confirm your card payment.
              </p>
              <p className="mt-1 text-sm leading-relaxed text-mist-500">
                Please call us on <strong className="text-ink">01747 637070</strong> before trying
                again so we can check whether anything was taken — or pay by bank transfer below.
              </p>
            </div>
          ) : null}

          <p className="text-sm leading-relaxed text-mist-500">
            Thanks{quote.accepted_name ? `, ${quote.accepted_name.split(/\s+/)[0]}` : ""} — quote{" "}
            <strong className="text-ink">{quote.quote_ref}</strong> is accepted. Your date is
            reserved and locks in as soon as the deposit arrives.
          </p>

          {cardOk ? (
            <>
              <PayCardButton token={token} amountLabel={gbp(deposit)} />
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-mist-400">
                <span className="h-px flex-1 bg-mist-150" />
                or
                <span className="h-px flex-1 bg-mist-150" />
              </div>
            </>
          ) : null}

          <BankPanel reference={quote.quote_ref} />

          {quote.deposit_selfreport_at ? (
            <div className="flex items-start gap-2.5 rounded-md border border-mist-200 bg-mist-50 p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.75} />
              <p className="text-sm leading-relaxed text-mist-500">
                Thanks — you&apos;ve told us the transfer is on its way. We&apos;re checking the
                bank and will email your confirmation as soon as it lands.
              </p>
            </div>
          ) : (
            <DepositSentButton token={token} />
          )}

          {quote.zoho_deposit_invoice_number && quote.zoho_deposit_invoice_url ? (
            <p className="text-center text-xs text-mist-400">
              Your deposit invoice{" "}
              <a
                href={quote.zoho_deposit_invoice_url}
                className="font-semibold text-ink underline underline-offset-2"
              >
                {quote.zoho_deposit_invoice_number}
              </a>{" "}
              is ready to view.
            </p>
          ) : null}

          <div className="flex items-center justify-center gap-2 border-t border-mist-150 pt-4 text-sm text-mist-500">
            <PhoneCall className="size-4 text-mm-red" strokeWidth={1.75} />
            Prefer to sort it by phone? Call{" "}
            <a href="tel:01747637070" className="font-semibold text-ink">
              01747 637070
            </a>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
