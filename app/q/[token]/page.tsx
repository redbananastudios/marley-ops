import type { Metadata } from "next";
import { CalendarCheck2, CheckCircle2, PhoneCall, ShieldCheck } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeBalanceCredits,
  ensureCommitmentInvoice,
  ensureDepositInvoice,
  fetchQuoteByToken,
  isRealZohoId,
  snapshotPaymentPolicy,
  syncZohoPayments,
  type AcceptQuoteRow,
} from "@/lib/quote/accept-flow";
import { isAcceptExpired, moveDateLabel } from "@/lib/quote/payments";
import { policyOfQuote, requestedDeposit } from "@/lib/payments-policy";
import { payInFullAvailable } from "@/lib/payments/pay-in-full";
import { getBusinessSettings } from "@/lib/settings";
import { cardPaymentsAvailable } from "@/lib/payments/card-payments";
import { BANK_DETAILS } from "@/lib/comms/payment-email";
import { getBrandOrDefault } from "@/lib/brand";
import { pageTheme, pageTitle, type PageTheme } from "@/lib/brand-page-theme";
import { DateConfirmCard } from "@/components/quote/date-confirm-card";
import { CommitmentChoice } from "@/components/quote/commitment-choice";
import { AcceptForm } from "./accept-form";
import { DeclineOption, DepositSentButton } from "./customer-actions";
import { PayCardButton } from "./pay-card-button";

/**
 * PUBLIC customer page — linked from the quote email CTA, the PDF QR codes and
 * SMS. One URL for the whole journey: accept → pay deposit → confirmed.
 * The unguessable token is the credential; anything else 404-shapes to the
 * friendly not-found card. Never indexed.
 *
 * Brand (multi-brand PRD §4, gate 16): every piece of identity on this page —
 * logo, name, phone, terms link, accent, and whether the word "card" appears at
 * all — comes from `pageTheme`, resolved ONCE from the quote's own brand before
 * any branch renders. It used to be hardcoded, and at some volume: the default
 * brand's phone number alone appeared twelve times, across the not-found, declined,
 * cancelled, expired, failed-card, error-card, balance and footer states. A
 * per-state literal is a per-state chance to miss one, and the state a customer
 * lands in is not the state anyone tests first.
 */

export const dynamic = "force-dynamic";

/**
 * The tab title is identity too. A customer of one brand whose browser tab
 * names a different one has been told something wrong before the page even
 * paints, and
 * it is the one string that survives into a shared link preview.
 *
 * Its own read: metadata is resolved separately from the page body by Next, so
 * there is no resolved theme to borrow here. One small extra read on a public
 * page that is already `force-dynamic`.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const sb = createAdminClient();
  const quote = await fetchQuoteByToken(sb, token);
  const theme = pageTheme(quote ? await getBrandOrDefault(sb, quote.brand) : null);
  return {
    title: pageTitle(theme, "Your quote"),
    robots: { index: false, follow: false },
  };
}

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

function Shell({ theme, children }: { theme: PageTheme; children: React.ReactNode }) {
  // One override, whole subtree. Tailwind v4 compiles the mm-red utilities to
  // `var(--color-mm-red)`, so re-pointing the token on this element recolours
  // every descendant that uses it — including the hover and focus variants
  // inside the child components, which an inline style cannot reach at all.
  // Undefined for the default brand: no style attribute, and every class below
  // stays exactly as it was.
  return (
    <main
      className="min-h-dvh bg-mist-50 px-4 py-8 sm:py-14"
      style={theme.rootStyle as React.CSSProperties | undefined}
    >
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 text-center">
          {theme.logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={theme.logoUrl} alt={theme.name} width={170} className="mx-auto h-auto" />
          ) : (
            /* A brand whose logo asset has not landed yet renders its NAME.
               Falling back to the default brand's /logo.png would put the wrong
               logo on another brand's page — the one answer worse than none. */
            <span
              className="font-brand text-2xl font-bold tracking-tight"
              style={{ color: theme.wordmarkColour }}
            >
              {theme.name}
            </span>
          )}
          {/* PRD §2: the group mark appears wherever a non-default brand's logo
              does, so a customer is not surprised by the operating company's
              bank account, or by a vehicle in another livery on the day. Empty
              for the default brand, which IS the group. */}
          {theme.groupLine ? (
            <p className="mt-2 text-xs font-medium text-mist-400">{theme.groupLine}</p>
          ) : null}
        </div>
        {children}
        <p className="mt-6 text-center text-xs leading-relaxed text-mist-400">
          {theme.legalLine}
          <br />
          Questions? Call{" "}
          <a href={theme.telHref} className="font-semibold text-ink">
            {theme.phone}
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

/** No quote resolved, so there is no brand to read — the default theme is the
 *  honest answer, and the only one available. */
function NotFoundCard({ theme }: { theme: PageTheme }) {
  return (
    <Shell theme={theme}>
      <Card>
        <div className="p-6 text-center sm:p-8">
          <h1 className="font-brand text-3xl font-semibold text-ink">
            We can&apos;t find that quote
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-mist-500">
            This link is no longer valid. If you were expecting to see your removal quote, call us
            on <strong className="text-ink">{theme.phone}</strong> and we&apos;ll sort it straight
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

function BankPanel({ reference, theme }: { reference: string; theme: PageTheme }) {
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
      {/* PRD §3.5 disclosure, placed HERE rather than in a footer: the account
          name says MARLEYMOVES LTD, and the surprise happens at the moment the
          customer reads it. One shared bank account for both brands is the
          deliberate design (§2) — this is the sentence that makes it make
          sense. The default brand renders nothing extra; it IS the operating
          company. */}
      {theme.groupLine ? (
        <p className="mt-2 text-xs leading-relaxed text-mist-500">
          {theme.name} is part of {theme.legalEntity}, so your payment goes to the{" "}
          <strong className="text-ink">{BANK_DETAILS.name}</strong> account above. Please use
          reference <strong className="text-ink">{reference}</strong> so we can match it to your
          booking.
        </p>
      ) : null}
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

  // Resolved ONCE, before any branch renders, from the quote's own brand. Every
  // state below — declined, cancelled, expired, card-failed, the accept screen
  // itself — speaks as the same brand because they all read this one value. The
  // alternative, resolving per branch, is how one state keeps the old literal.
  //
  // No quote means no brand to read: the default theme is the only answer
  // available and the honest one.
  const theme = pageTheme(quote ? await getBrandOrDefault(sb, quote.brand) : null);

  // Customer declined from this page — acknowledge, don't 404 them.
  if (quote?.status === "rejected" && quote.declined_at) {
    return (
      <Shell theme={theme}>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">Thanks for letting us know</h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              We&apos;ve closed the quote and you won&apos;t get any more reminders from us. If
              anything changes, call <strong className="text-ink">{theme.phone}</strong> and
              we&apos;ll pick it straight back up. All the best with the move.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  // Only quotes the customer was actually sent (or has accepted) resolve here.
  if (!quote || (quote.status !== "sent" && quote.status !== "accepted")) return <NotFoundCard theme={theme} />;

  // Card via takepayments — env creds, the global kill switch, AND this quote's
  // brand switch, all three (PRD §11.10). The brand clause was missing until
  // 2026-08-27: a brand with card deliberately off still got the button here
  // while every one of its emails said bank transfer was the only route
  // (QA-20260826-07). That is exactly the combination a bank-transfer-only
  // brand launches in.
  //
  // Hoisted above the branches so the settled-balance copy can read it too:
  // that copy sits in an earlier branch than the old declaration, and gating
  // it on the BRAND flag alone would have offered card while the global kill
  // switch was down — the one combination PRD §11.10 forbids.
  const cardOk = await cardPaymentsAvailable(sb, quote.brand).catch(() => false);

  // A cancelled booking's emailed link must never solicit payment (its unpaid
  // invoices were voided) or offer date confirmation — booking_cancelled_at is
  // stamped by the cancel and mark-lost unwinds and cleared on reopen.
  if (quote.status === "accepted" && quote.booking_cancelled_at) {
    return (
      <Shell theme={theme}>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">
              This booking has been cancelled
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              There&apos;s nothing to pay on this page. If anything you&apos;ve paid is due back
              to you, it&apos;s being processed and we&apos;ll confirm by email. Any questions —
              or if you&apos;d like to rebook — call{" "}
              <strong className="text-ink">{theme.phone}</strong>.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  if (quote.status === "sent" && isAcceptExpired(quote.email_sent_at, quote.created_at)) {
    return (
      <Shell theme={theme}>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <h1 className="font-brand text-3xl font-semibold text-ink">This quote has expired</h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              Quotes are valid for 30 days. Prices may have changed, so give us a quick call on{" "}
              <strong className="text-ink">{theme.phone}</strong> and we&apos;ll refresh it for you.
            </p>
          </div>
        </Card>
      </Shell>
    );
  }

  const total = quote.agreed_price ?? Number(quote.grand_total ?? 0);
  // Settings, not constants. This page shows the customer the figure they are
  // about to pay, and accept-flow computes the figure they are actually
  // invoiced — so the two must read the SAME inputs or the page quotes one
  // number and the invoice asks another. The deposit default was hardcoded 100
  // here while every other money surface read it from settings: identical
  // today, and silently wrong the first time anyone edits it.
  const settings = await getBusinessSettings(sb);
  const baseDeposit = quote.deposit_amount ?? settings.defaultDeposit;
  // Pre-accept, the ask is computed live (a small job asks for the whole thing;
  // a move inside 7 days takes the full 25% up-front — late-booking collapse);
  // once accepted, deposit_amount is the frozen truth every money surface reads.
  const deposit =
    quote.status === "sent"
      ? requestedDeposit(total, baseDeposit, quote.moving_date, settings.smallJobThreshold)
      : baseDeposit;

  /* ------------------------------------------------- commercial → review */
  // Resolved LIVE from the client, not read off the quote: `payment_policy`
  // is only snapshotted at acceptance, so on a `sent` quote it is null for
  // every booking, commercial ones included. Reading the column here would
  // make this branch unreachable exactly when it is needed. Same lookup the
  // server refusal uses, so the page and the write can never disagree about
  // which ladder a quote is on.
  //
  // QA-20260828-03: gate 10b closed the WRITE path — a commercial customer
  // who clicked Accept got a correct refusal and no side effect — but this
  // page still rendered the whole residential screen at them: a headline
  // deposit figure they do not owe, copy promising card or bank transfer on
  // the next screen, and an enabled Accept button. Safe, and still wrong to
  // put in front of a client who has been told they are on account terms.
  if (quote.status === "sent" && (await snapshotPaymentPolicy(sb, quote)) === "commercial") {
    return (
      <Shell theme={theme}>
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
              {quote.customer_name
                ? `Here is your quote, ${quote.customer_name.split(/\s+/)[0]}.`
                : "Here is your quote."}
            </h1>
            <SummaryRows quote={quote} />
            <div className="flex items-start gap-3 rounded-md border border-mist-200 bg-mist-50 p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
              <p className="text-sm leading-relaxed text-mist-500">
                Nothing to pay now. We&apos;ll confirm this booking with you and invoice your
                account once the job is done, payable on your agreed terms. Read our{" "}
                <a
                  href={theme.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-ink underline underline-offset-2"
                >
                  terms &amp; conditions
                </a>
                .
              </p>
            </div>
            {/* Declining stays: it creates no money state, and telling us no is
                information we want. Only the ACCEPT action is the office's. */}
            <DeclineOption token={token} phone={theme.phone} />
          </div>
        </Card>
      </Shell>
    );
  }

  /* ---------------------------------------------------------- sent → accept */
  if (quote.status === "sent") {
    return (
      <Shell theme={theme}>
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
                <strong className="text-ink">{gbp(deposit)} deposit</strong> secures the booking —{" "}
                {/* The rails named here must be the rails the NEXT screen
                    actually offers. This sentence promised card unconditionally
                    while the button below it has always been gated on `cardOk`,
                    so a customer whose brand takes bank transfer only was told
                    they could pay by card, accepted on that basis, and arrived
                    at a screen with no card on it. The commercial branch
                    returns earlier, so a residential quote is what reaches
                    this.

                    The card-off arm is not the card-on arm with the word
                    removed: bank transfer is the instruction, and the phone is
                    a real second route (the deposit screen ends with "Prefer to
                    sort it by phone?"), not a hedge like "where available"
                    that would stop the lie without telling anyone what to do. */}
                {cardOk
                  ? "pay by card or bank transfer on the next screen."
                  : "pay by bank transfer on the next screen, or call us and we'll sort it with you."}{" "}
                The balance is due before move day. Read our{" "}
                <a
                  href={theme.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-ink underline underline-offset-2"
                >
                  terms &amp; conditions
                </a>
                .
              </p>
            </div>
            <AcceptForm token={token} depositLabel={gbp(deposit)} termsUrl={theme.termsUrl} />
            <DeclineOption token={token} phone={theme.phone} />
          </div>
        </Card>
      </Shell>
    );
  }

  /* --------------------------------------- accepted + commercial → on account */
  // The commercial gate above covers `status === "sent"` ONLY, and the office
  // marking the job won moves the row straight past it. Everything below this
  // point is the residential ladder — a deposit ask, a date confirmation, a
  // commitment, a balance due before move day — and a commercial booking has
  // none of those rungs. Left to fall through, a client on account terms
  // revisiting their own link met a screen headed "deposit to secure your
  // date", carrying a figure taken from the Settings default rather than from
  // their own quote, for money nobody had ever asked them for.
  //
  // It returns BEFORE the deposit machinery rather than correcting it after:
  // `ensureDepositInvoice` already refuses this policy, so reaching it at all is
  // not a safety question, it is simply one more chance to render the wrong
  // screen.
  //
  // The policy is read straight off the row. Both accept paths stamp
  // `payment_policy` at acceptance, so by this state it is the snapshot every
  // money surface reads; re-resolving it live (which is right on the `sent`
  // state, where the column is still null) could disagree with the ladder the
  // booking is actually on.
  if (policyOfQuote(quote) === "commercial") {
    let settledAt: string | null = null;
    let settledUnknown = false;
    if (quote.lead_id) {
      const { data: lead, error: leadErr } = await sb
        .from("leads")
        .select("balance_paid_at")
        .eq("id", quote.lead_id)
        .maybeSingle();
      // "I could not check" and "not paid" are different answers. A failed
      // read left `settledAt` null, which rendered the full "Amount due"
      // panel as if the payment position were known — to a client who may
      // have settled weeks ago.
      if (leadErr) settledUnknown = true;
      settledAt = lead?.balance_paid_at ?? null;
    }
    const moveOn = moveDateLabel(quote.moving_date);
    const invoiceAmt = Number(quote.balance_invoice_amount ?? 0);
    const invoiceRaised = isRealZohoId(quote.zoho_balance_invoice_id) && invoiceAmt > 0;
    const showInvoice = invoiceRaised && !settledAt && !settledUnknown;
    // A terms date that was never recorded names no day here either. The terms
    // themselves are the whole truth available, and they are what the quote and
    // the invoice document have already told this client.
    const termsOn = moveDateLabel(quote.commercial_due_date ?? null);
    return (
      <Shell theme={theme}>
        <Card>
          <div className="p-6 text-center sm:p-8">
            <CheckCircle2 className="mx-auto size-12 text-success" strokeWidth={1.5} />
            <h1 className="mt-4 font-brand text-3xl font-semibold text-ink">
              {settledAt ? "All settled" : "You're booked in"}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-mist-500">
              Quote <strong className="text-ink">{quote.quote_ref}</strong> is confirmed
              {moveOn ? (
                <>
                  {" "}
                  for <strong className="text-ink">{moveOn}</strong>
                </>
              ) : null}
              .{" "}
              {settledAt
                ? "Your invoice is paid in full, so there is nothing further to do. Thank you."
                : invoiceRaised && settledUnknown
                  ? "We could not confirm your payment position just now, so we are not showing an amount here. Your invoice was sent by email, and if you have already paid it there is nothing further to do."
                  : showInvoice
                    ? "Your invoice is below."
                    : "There is nothing to pay now. We'll invoice your account once the job is done, payable on your agreed terms."}
            </p>
          </div>
        </Card>

        {showInvoice ? (
          <div className="mt-6">
            <Card>
              <div className="space-y-5 p-6 sm:p-8">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-mist-500">
                    Amount due
                    {quote.zoho_balance_invoice_number
                      ? ` · Invoice ${quote.zoho_balance_invoice_number}`
                      : ""}
                  </p>
                  <p className="mt-1 font-brand text-4xl font-bold text-ink">{gbp(invoiceAmt)}</p>
                  <p className="mt-2 text-sm leading-relaxed text-mist-500">
                    Your move is complete, so this is your invoice for the job. It is payable on
                    your agreed terms
                    {termsOn ? (
                      <>
                        , by <strong className="text-ink">{termsOn}</strong>
                      </>
                    ) : null}
                    .
                  </p>
                </div>
                <BankPanel theme={theme} reference={quote.quote_ref} />
                {/* No card rail: the completion invoice is raised with online
                    payments disabled, so a card button here would be a dead
                    end — the same reason the residential balance has none. */}
                <p className="text-sm leading-relaxed text-mist-500">
                  Any questions about this invoice? {theme.callLead}{" "}
                  <a
                    href={theme.telHref}
                    className="font-semibold text-mm-red underline underline-offset-2"
                  >
                    {theme.phone}
                  </a>
                  .
                </p>
                {quote.zoho_balance_invoice_url ? (
                  <p className="text-center text-xs text-mist-400">
                    Your invoice{" "}
                    <a
                      href={quote.zoho_balance_invoice_url}
                      className="font-semibold text-ink underline underline-offset-2"
                    >
                      {quote.zoho_balance_invoice_number ?? "is ready"}
                    </a>{" "}
                    is ready to view.
                  </p>
                ) : null}
              </div>
            </Card>
          </div>
        ) : null}
      </Shell>
    );
  }

  /* ------------------------------------------------- accepted → pay / done */
  // Self-heal a missing deposit invoice, then pick up any card payment made
  // since the last visit (instant confirmation when they return from Zoho).
  if (!quote.deposit_paid_at) {
    quote = (await ensureDepositInvoice(sb, quote.id)) ?? quote;
    quote = (await syncZohoPayments(sb, quote)).quote;
  }

  if (quote.deposit_paid_at) {
    // Date-confirmation state (Payments Policy v2 §5A) lives on the LEAD —
    // null = deposit still fully refundable, so the confirm card shows.
    // balance_paid_at rides along: it decides whether the final-balance card
    // below asks for money or reports the job settled.
    let dateConfirmedAt: string | null = null;
    let balancePaidAt: string | null = null;
    if (quote.lead_id) {
      const { data: lead } = await sb
        .from("leads")
        .select("date_confirmed_at, balance_paid_at")
        .eq("id", quote.lead_id)
        .maybeSingle();
      dateConfirmedAt = lead?.date_confirmed_at ?? null;
      balancePaidAt = lead?.balance_paid_at ?? null;
    }
    if (dateConfirmedAt) {
      // Self-heal a missing commitment invoice (a prior partial failure) and
      // pick up a commitment payment recorded in Zoho since the last visit.
      quote = (await ensureCommitmentInvoice(sb, quote.id)) ?? quote;
      if (quote.zoho_commitment_invoice_id && !quote.commitment_paid_at) {
        quote = (await syncZohoPayments(sb, quote)).quote;
      }
    }

    const moveLbl = moveDateLabel(quote.moving_date);
    const commitAmt = Number(quote.commitment_invoice_amount ?? 0);
    const commitDueLbl = moveDateLabel(quote.commitment_due_date);
    const showConfirmCard = !dateConfirmedAt && !!moveLbl && !!quote.lead_id;

    // Once the final invoice is raised there IS something to pay, and this page
    // is where the customer looks for it — the balance email's own copy points
    // them back to their booking. Until now the page never read the balance at
    // all, so it went on saying "nothing more to pay right now" while a real
    // invoice sat unpaid; Greig James (MMR015, 2026-08-20) had to email and ask
    // where to pay, five days after his £740 invoice went out. Bank transfer,
    // phone card or cash only, per the pricing decision of 2026-07-09 — no card
    // button here, and the Zoho invoice itself is raised with online payments
    // disabled, so linking one would be a dead end.
    const balanceInvoiced = isRealZohoId(quote.zoho_balance_invoice_id);
    const balanceAmt = Number(quote.balance_invoice_amount ?? 0);
    const showBalanceCard = balanceInvoiced && balanceAmt > 0;

    // Gate 9a: on a small job the FROZEN acceptance ask was the whole price —
    // the commitment clamps to 0 and no balance invoice ever raises, so
    // balance_paid_at never stamps. Without this flag the page promised "the
    // balance" and a future final invoice forever, on a job that has neither.
    // Checked AFTER the invoice signals above so an issued balance invoice
    // (which should not coexist with a covering ask) keeps its authority.
    const paidInFull = total > 0 && deposit >= total;

    // Settle-in-full at the commitment step (PRD §3.10 Addition 3). The SAME
    // rule the server action enforces decides whether the choice renders: an
    // option the page offers and the server refuses is worse than no option.
    // When it is unavailable the commitment step renders exactly as it does
    // today, so every booking that is not at this step is untouched.
    const canPayInFull = payInFullAvailable(quote, {
      date_confirmed_at: dateConfirmedAt,
      balance_paid_at: balancePaidAt,
    });
    // What would remain after the commitment — the T-7 balance, computed by the
    // one function that also computes what the invoice will actually say, so
    // the figure the customer picks is the figure they are billed. Read only
    // when the choice is on offer; it costs two queries.
    const balanceRemaining = canPayInFull ? (await computeBalanceCredits(sb, quote)).amount : 0;

    return (
      <Shell theme={theme}>
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
              is secured. We&apos;ve emailed your confirmation
              {balancePaidAt ? (
                <> and your balance is settled in full, so there is nothing left to pay.</>
              ) : showBalanceCard ? (
                <> — your final balance is below.</>
              ) : paidInFull ? (
                <> — your payment covers the whole job, so there is nothing more to pay.</>
              ) : (
                <>
                  {" "}
                  — the remaining balance is due before move day and we&apos;ll send the final
                  invoice nearer the time.
                </>
              )}
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
                      {canPayInFull ? (
                        <> Or settle the whole thing now and have nothing left to pay.</>
                      ) : null}
                    </p>
                    {canPayInFull ? (
                      <CommitmentChoice
                        token={token}
                        quoteRef={quote.quote_ref}
                        commitmentAmount={commitAmt}
                        commitmentDueLabel={commitDueLbl}
                        balanceRemaining={balanceRemaining}
                        moveDateLabel={moveLbl}
                        bank={{
                          name: BANK_DETAILS.name,
                          sortCode: BANK_DETAILS.sortCode,
                          account: BANK_DETAILS.account,
                        }}
                        // Same gate as BankPanel's PRD §3.5 line: the default
                        // brand IS the operating company and renders nothing.
                        disclosure={
                          theme.groupLine
                            ? { brandName: theme.name, legalEntity: theme.legalEntity }
                            : null
                        }
                      />
                    ) : (
                      <BankPanel theme={theme} reference={quote.quote_ref} />
                    )}
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
                    Your {gbp(commitAmt)} commitment payment is received — thank you.{" "}
                    {balancePaidAt
                      ? "Your balance is settled too, so there is nothing left to pay."
                      : showBalanceCard
                        ? "Your final balance is below."
                        : "The remaining balance is due in full before move day."}
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-mist-500">
                    Your deposit already covers the commitment for your booking
                    {balancePaidAt
                      ? ", and your balance is settled in full."
                      : showBalanceCard
                        ? ". Your final balance is below."
                        : paidInFull
                          ? ", and it covers the whole job — there is nothing more to pay."
                          : ", so there is nothing more to pay right now. The remaining balance is due in full before move day."}
                  </p>
                )}
              </div>
            </Card>
          </div>
        ) : null}

        {showBalanceCard ? (
          <div className="mt-6">
            <Card>
              <div className="space-y-5 p-6 sm:p-8">
                {balancePaidAt ? (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.75} />
                    <div>
                      <h2 className="font-brand text-xl font-semibold text-ink">All settled</h2>
                      <p className="mt-1 text-sm leading-relaxed text-mist-500">
                        We have received your final balance of{" "}
                        <strong className="text-ink">{gbp(balanceAmt)}</strong>, so there is nothing
                        more to pay
                        {moveLbl ? (
                          <>
                            {" "}
                            before <strong className="text-ink">{moveLbl}</strong>
                          </>
                        ) : null}
                        . Thank you.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-mist-500">
                        Final balance
                        {quote.zoho_balance_invoice_number
                          ? ` · Invoice ${quote.zoho_balance_invoice_number}`
                          : ""}
                      </p>
                      <p className="mt-1 font-brand text-4xl font-bold text-ink">
                        {gbp(balanceAmt)}
                      </p>
                      <p className="mt-2 text-sm leading-relaxed text-mist-500">
                        Payment in full is due before your move
                        {moveLbl ? (
                          <>
                            {" "}
                            on <strong className="text-ink">{moveLbl}</strong>
                          </>
                        ) : null}
                        . Your deposit
                        {commitAmt > 0 ? " and commitment payment are" : " is"} already accounted
                        for.
                      </p>
                    </div>
                    <BankPanel theme={theme} reference={quote.quote_ref} />
                    {/* "card" appears only where the brand can actually take
                        one (PRD §11.10). Offering a customer a rail their brand
                        does not have is worse than saying nothing: they would
                        ring up to use it. */}
                    <p className="text-sm leading-relaxed text-mist-500">
                      {cardOk
                        ? "Prefer to pay by card or cash? "
                        : "Prefer to pay by cash, or have a question? "}
                      {theme.callLead}{" "}
                      <a
                        href={theme.telHref}
                        className="font-semibold text-mm-red underline underline-offset-2"
                      >
                        {theme.phone}
                      </a>
                      .
                    </p>
                    {quote.zoho_balance_invoice_url ? (
                      <p className="text-center text-xs text-mist-400">
                        Your invoice{" "}
                        <a
                          href={quote.zoho_balance_invoice_url}
                          className="font-semibold text-ink underline underline-offset-2"
                        >
                          {quote.zoho_balance_invoice_number ?? "is ready"}
                        </a>{" "}
                        is ready to view.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </Card>
          </div>
        ) : null}
      </Shell>
    );
  }


  // A move inside T-7 has its final balance raised at acceptance rather than
  // by the T-7 cron the next morning (PRD §3.10 Addition 2), so this state —
  // deposit still unpaid — is now the FIRST place a customer can meet both
  // invoices. The page said only "deposit to secure your date" while a second,
  // larger invoice sat in their inbox: the same gap Greig James found on the
  // settled side (MMR015). Bank transfer, phone card or cash for the balance,
  // per 2026-07-09 — the card button above stays deposit-only.
  const earlyBalanceAmount = isRealZohoId(quote.zoho_balance_invoice_id)
    ? Number(quote.balance_invoice_amount ?? 0)
    : 0;

  return (
    <Shell theme={theme}>
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
                If it keeps happening, call us on <strong className="text-ink">{theme.phone}</strong>{" "}
                and we&apos;ll sort it together.
              </p>
            </div>
          ) : cardResult === "error" ? (
            <div className="rounded-md border border-warn-border bg-warn-bg p-4">
              <p className="text-sm font-semibold text-ink">
                We couldn&apos;t confirm your card payment.
              </p>
              <p className="mt-1 text-sm leading-relaxed text-mist-500">
                Please call us on <strong className="text-ink">{theme.phone}</strong> before trying
                again so we can check whether anything was taken — or pay by bank transfer below.
              </p>
            </div>
          ) : null}

          <p className="text-sm leading-relaxed text-mist-500">
            Thanks{quote.accepted_name ? `, ${quote.accepted_name.split(/\s+/)[0]}` : ""} — quote{" "}
            <strong className="text-ink">{quote.quote_ref}</strong> is accepted. Your deposit
            secures your booking; once it arrives, you can confirm your moving date right here to
            lock it in.
          </p>

          {earlyBalanceAmount > 0 ? (
            <div className="rounded-md border border-mist-200 bg-mist-50 p-4">
              <p className="text-sm leading-relaxed text-mist-500">
                Your move is close, so your final balance of{" "}
                <strong className="text-ink">{gbp(earlyBalanceAmount)}</strong>
                {quote.zoho_balance_invoice_number ? (
                  <>
                    {" "}
                    (invoice{" "}
                    {quote.zoho_balance_invoice_url ? (
                      <a
                        href={quote.zoho_balance_invoice_url}
                        className="font-semibold text-ink underline underline-offset-2"
                      >
                        {quote.zoho_balance_invoice_number}
                      </a>
                    ) : (
                      <strong className="text-ink">{quote.zoho_balance_invoice_number}</strong>
                    )}
                    )
                  </>
                ) : null}{" "}
                has been invoiced at the same time rather than a few days from now. That is{" "}
                <strong className="text-ink">{gbp(deposit + earlyBalanceAmount)}</strong> in total
                before move day. You can pay the two separately or in one transfer — either way,
                use reference <strong className="text-ink">{quote.quote_ref}</strong>.
              </p>
            </div>
          ) : null}

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

          <BankPanel theme={theme} reference={quote.quote_ref} />

          {quote.deposit_selfreport_at ? (
            <div className="flex items-start gap-2.5 rounded-md border border-mist-200 bg-mist-50 p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.75} />
              <p className="text-sm leading-relaxed text-mist-500">
                Thanks — you&apos;ve told us the transfer is on its way. We&apos;re checking the
                bank and will email your confirmation as soon as it lands.
              </p>
            </div>
          ) : (
            <DepositSentButton token={token} phone={theme.phone} />
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
            <a href={theme.telHref} className="font-semibold text-ink">
              {theme.phone}
            </a>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
