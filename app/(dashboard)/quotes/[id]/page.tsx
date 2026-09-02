import { notFound } from "next/navigation";
import { CheckCircle2, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { brandForComms } from "@/lib/comms/brand-theme";
import { PageHeader } from "@/components/page-header";
import { BrandChip } from "@/components/brand/brand-chip";
import { normalizeQuoteValues } from "@/lib/quote/form-types";
import { getPricingConfig } from "@/lib/quote/pricing-config";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { ensureAcceptToken, acceptUrlFor, snapshotPaymentPolicy } from "@/lib/quote/accept-flow";
import { QuoteBuilder } from "@/components/quote/quote-builder";
import type { CubicQuoteHint } from "@/components/quote/wizard-steps";
import { computeCubicTotals, recommendVans, sanitizeCubicLines, vehicleShortLabel } from "@/lib/cubic-survey";
import { getSurveyPlanningState } from "@/lib/ai/planning";
import { CubicSurveyCard, type CubicCardData } from "@/components/cubic/cubic-survey-card";
import { QuoteView } from "@/components/quote/quote-view";
import {
  CompletionCard,
  ContractSignatureCard,
  type CompletionView,
  type ContractSignatureView,
} from "@/components/quote/signature-cards";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET } from "@/lib/signatures";
import { loadJobNotesForLead, type JobNoteView } from "@/lib/job-notes";
import { CrewNotesCard } from "@/components/crew-notes-card";
import { QuoteHeaderActions } from "@/components/quote/quote-header-actions";
import { policyOfQuote, requestedDeposit, type PaymentPolicy } from "@/lib/payments-policy";
import { cardPaymentsAvailable } from "@/lib/payments/card-availability";
import { paymentLinkFor } from "@/lib/payments/payment-link";
import { SendPaymentLinkButton } from "@/components/leads/send-payment-link-button";
import { QuoteStatusPill, QuoteMetaChip } from "@/components/quote/quote-status-pill";
import { ChaseStatusLine } from "@/components/comms/chase-status-line";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * /quotes/[id] — the quote builder for one draft. Loads the row, hydrates the
 * wizard from state_blob, and shows the header (ref + status + grand total +
 * status control + Emailed ×N).
 *
 * Next 16: params is async.
 */
export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const sb = await createClient();

  const { data: quote } = await sb
    .from("quotes")
    .select(
      "id, quote_ref, status, source, standard_comms_at, imve_ref, imve_zoho_invoice_number, grand_total, agreed_price, accepted_at, email_sent_at, state_blob, lead_id, client_id, email_send_count, customer_name, deposit_amount, deposit_paid_at, booking_cancelled_at, subtotal, discount, additional_charges, additional_charges_reason, vat_enabled, vat_amount, moving_date, estimator_id, brand, payment_policy",
    )
    .eq("id", id)
    .maybeSingle();

  if (!quote) notFound();

  /**
   * Which ladder this quote runs — the customer-facing quote PDF and email are
   * composed from this page's props, so it decides what the customer is asked
   * for (PRD §3.10).
   *
   * The column WINS once it is set: it is the snapshot taken at acceptance, and
   * re-typing a client afterwards must never re-write the documents of a
   * booking already in flight. But it is null on every draft and sent quote —
   * which is precisely the window in which the quote is in front of the
   * customer — so a page that only read the column would resolve every live
   * commercial quote to residential and print a deposit demand. That is the
   * defect QA-20260828-03 recorded against /q; the fix there was to resolve
   * live, and it has to be the same rule here or the page and its own PDF
   * would disagree.
   */
  const paymentPolicy: PaymentPolicy = quote.payment_policy
    ? policyOfQuote(quote)
    : await snapshotPaymentPolicy(sb, quote);

  // Estimator name for the PDF "Prepared by" line.
  const {
    data: { user },
  } = await sb.auth.getUser();
  const estimatorName =
    (user?.user_metadata?.full_name as string | undefined) ?? user?.email ?? null;

  const blobValues = normalizeQuoteValues(quote.state_blob);
  // `quotes.moving_date` is the authoritative move date: rescheduleAppointment
  // and the Change-date flow both write the COLUMN and never touch state_blob.
  // The builder edits the blob and autosaves it back over the column, so
  // opening a rescheduled quote and changing anything at all silently reverted
  // the confirmed date — leaving the diary and the money layer disagreeing with
  // no error. Seed the form from the column so what you see, and what you save
  // back, is the real date.
  // `moving_date` is a text column and legacy rows imported from Neon carry
  // whatever was in the old system, so only a real yyyy-mm-dd is safe to hand
  // to <input type="date"> — anything else renders as an empty field, which
  // reads as "no date" and autosaves back as null.
  const authoritativeMoveDate =
    typeof quote.moving_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(quote.moving_date)
      ? quote.moving_date
      : null;
  const initialValues =
    authoritativeMoveDate && authoritativeMoveDate !== blobValues.job.moveDate
      ? {
          ...blobValues,
          // A date that came off the diary or the change-date flow is confirmed,
          // never an estimate — otherwise the quote view labels it "(estimated)".
          job: { ...blobValues.job, moveDate: authoritativeMoveDate, moveDateEstimated: false },
        }
      : blobValues;
  const [pricing, settings, quoteBrand, activeBrands] = await Promise.all([
    getPricingConfig(sb),
    getBusinessSettings(sb),
    // The quote's brand row for the send dialog — subject, email chrome and
    // the attachment name all resolve from it (multi-brand PRD §3.5). The PDF's
    // slim DocBrand is derived from this same row at the point of use
    // (docBrandFrom, null for Marley), so one read serves comms and documents.
    // Resolved through brandForComms, NOT getBrandOrDefault: this row feeds
    // customer COPY (the quote email's card wording via `offerCard`), so its
    // cardPaymentsEnabled must be the EFFECTIVE two-switch verdict — global
    // AND brand (PRD §11.10) — never the stored toggle alone. docBrandFrom
    // reads no card field, so the PDF is untouched by the substitution.
    brandForComms(sb, quote.brand),
    // Multi-brand only: the header chip renders when a second brand row is
    // active (the single-brand invariant, PRD §1).
    listActiveBrandsOrEmpty(sb),
  ]);
  const emailedCount = quote.email_send_count ?? 0;

  // Every quote gets its accept token here (lazily, idempotent) so the PDF QR
  // codes and the email CTA always point at the live /q/<token> page.
  const acceptToken = await ensureAcceptToken(sb, quote.id);
  const acceptUrl = acceptToken ? acceptUrlFor(acceptToken) : undefined;

  // Signed evidence for the office view: the contract signature (one per
  // quote) + the latest job-completion sign-off on the lead, with a
  // short-lived link to the stored certificate PDF.
  const { data: sigRow } = await sb
    .from("signatures")
    .select("signer_name, signature_data, method, channel, acknowledgments, terms_version, signed_at, collected_by")
    .eq("quote_id", quote.id)
    .eq("kind", "contract")
    .maybeSingle();
  let collectedByName: string | null = null;
  if (sigRow?.collected_by) {
    const { data: collector } = await sb.from("profiles").select("full_name").eq("id", sigRow.collected_by).maybeSingle();
    collectedByName = collector?.full_name ?? null;
  }
  const contractSignature = sigRow ? ({ ...sigRow, collectedByName } as ContractSignatureView) : null;

  // Cubic-survey: the van suggestion for the Vehicle step (suggest-only here;
  // new drafts were pre-selected at creation) + the card for the quote View.
  let cubicHint: CubicQuoteHint | null = null;
  let cubicCard: CubicCardData | null = null;
  if (quote.lead_id) {
    const { data: cubic } = await sb
      .from("cubic_surveys")
      .select("total_ft3, items, status, ai_status, planning_ready, contingency_pct")
      .eq("lead_id", quote.lead_id)
      .maybeSingle();
    if (cubic) {
      const totalFt3 = Number(cubic.total_ft3) || 0;
      const planning = getSurveyPlanningState({ rawFt3: totalFt3, aiStatus: cubic.ai_status, planningReady: cubic.planning_ready, contingencyPct: cubic.contingency_pct });
      const rec =
        planning.guidanceReady && planning.planningFt3 > 0
          ? recommendVans(planning.planningFt3, {
              fillPct: settings.cubicFillPct,
              transitFt3: settings.cubicTransitFt3,
              lutonFt3: settings.cubicLutonFt3,
              sevenFiveTFt3: settings.cubic75tFt3,
            })
          : null;
      const totals = computeCubicTotals(sanitizeCubicLines(cubic.items) ?? []);
      cubicCard = {
        rawFt3: totalFt3,
        planningFt3: planning.planningFt3,
        contingencyPct: planning.contingencyPct,
        guidanceReady: planning.guidanceReady,
        vanLabel: rec ? vehicleShortLabel(rec) : null,
        itemCount: totals.itemCount,
        status: cubic.status ?? "draft",
        hasSurvey: true,
      };
      if (rec) {
        cubicHint = {
          rawFt3: totalFt3,
          planningFt3: planning.planningFt3,
          contingencyPct: planning.contingencyPct,
          vehicleKey: rec.vehicleKey,
          shortLabel: vehicleShortLabel(rec),
          detail: rec.label + (rec.consider75t ? " · consider the 7.5t" : ""),
        };
      }
    }
  }

  let completion: CompletionView | null = null;
  let crewNotes: JobNoteView[] = [];
  if (quote.lead_id) {
    crewNotes = await loadJobNotesForLead(createAdminClient(), quote.lead_id);
    const { data: comp } = await sb
      .from("job_completions")
      .select(
        "id, customer_name, customer_absent, absent_reason, exceptions, crew_name, signed_at, certificate_emailed_at, certificate_path",
      )
      .eq("lead_id", quote.lead_id)
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (comp) {
      let certificateUrl: string | null = null;
      if (comp.certificate_path) {
        certificateUrl = await createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET })
          .createSignedGetUrl(comp.certificate_path, 3600)
          .catch(() => null);
      }
      const { certificate_path, ...rest } = comp;
      completion = { ...rest, certificateUrl, hasStoredCertificate: !!certificate_path };
    }
  }

  // The linked lead's context for the View-lead modal (no navigation away from the form)
  // + the chase-engine state (step counters + pause switch live on the lead).
  let leadOption = null;
  let leadStatus: string | null = null;
  let leadChasePaused = false;
  let leadQuoteChaseStep = 0;
  let leadDepositChaseStep = 0;
  if (quote.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select(
        "id,name,phone,email,status,from_postcode,from_address,to_postcode,to_address,property_size,notes,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign,chase_paused,quote_chase_step,deposit_chase_step",
      )
      .eq("id", quote.lead_id)
      .maybeSingle();
    if (lead) {
      const { notes, status, chase_paused, quote_chase_step, deposit_chase_step, ...l } = lead;
      leadStatus = status;
      leadChasePaused = chase_paused ?? false;
      leadQuoteChaseStep = quote_chase_step ?? 0;
      leadDepositChaseStep = deposit_chase_step ?? 0;
      leadOption = { ...l, lead_notes: notes, source: classifySource(l as unknown as LeadLite) };
    }
  }

  const statusStr = quote.status ?? "draft";
  // Drafts + explicit ?edit=1 open the wizard; everything else is the read-only
  // job card (which is where Edit becomes an offered action).
  const editing = statusStr === "draft" || sp.edit === "1";

  // Assignable office members for the sender picker (active admin/estimator).
  // Setting one makes the quote email front that person; leaving it as Office /
  // Accounts sends from accounts@. Only fetched when the editable builder renders.
  let estimatorOptions: { id: string; full_name: string }[] = [];
  if (editing) {
    const { data: members } = await sb
      .from("profiles")
      .select("id, full_name")
      .eq("active", true)
      .in("role", ["admin", "estimator"])
      .order("full_name", { ascending: true });
    estimatorOptions = (members ?? []).map((m) => ({ id: m.id, full_name: m.full_name ?? "Unnamed" }));
  }

  // Gate 9d (PRD §3.10) puts the office "Send payment link" action on TWO
  // surfaces — this page and /bookings — for the customer who phones in unable
  // to do a bank transfer. It shipped on /bookings alone, so the office already
  // looking at the quote they read the figure off had to go and hunt the
  // booking row, or take the card number down the phone: the exact thing the
  // action exists to replace.
  //
  // Same pure rule and same two-switch card verdict as /bookings (global kill
  // switch AND the brand's own — PRD §11.10), so a card-off brand still sees
  // nothing here, on a page whose every other rail says bank transfer.
  // Only the accepted-and-unpaid residential state can ever be offered a link,
  // so everything else short-circuits before the read rather than adding a
  // round trip to every draft. Commercial is excluded outright: it has no
  // deposit rung at all, which is why its header chip says "invoiced on
  // completion" rather than a figure.
  const depositOutstanding =
    statusStr === "accepted" && !quote.deposit_paid_at && paymentPolicy !== "commercial";
  const cardOk = depositOutstanding
    ? await cardPaymentsAvailable(sb, quote.brand).catch(() => false)
    : false;
  const paymentLink = paymentLinkFor(
    {
      status: statusStr,
      deposit_paid_at: quote.deposit_paid_at,
      deposit_amount: quote.deposit_amount,
      booking_cancelled_at: quote.booking_cancelled_at,
      source: quote.source,
      standard_comms_at: quote.standard_comms_at,
    },
    cardOk,
    settings.defaultDeposit,
  );

  const isLegacyImve = quote.source === "imve";
  const chipBrand =
    activeBrands.length > 1 ? activeBrands.find((b) => b.slug === quote.brand) : undefined;
  const headerMeta = (
    <>
      <QuoteStatusPill status={statusStr} />
      {/* Detail-page eyebrows have room, so the chip carries the short name
          (multi-brand PRD §4 opening rules). Reads the quote's own
          denormalised brand column — no lead join. */}
      {chipBrand ? <BrandChip brand={chipBrand} variant="eyebrow" /> : null}
      {isLegacyImve ? (
        <QuoteMetaChip>
          Legacy (iMVE{quote.imve_ref && quote.imve_ref !== quote.quote_ref ? ` ${quote.imve_ref}` : ""})
        </QuoteMetaChip>
      ) : null}
      {isLegacyImve && quote.imve_zoho_invoice_number ? (
        <QuoteMetaChip>Zoho draft {quote.imve_zoho_invoice_number}</QuoteMetaChip>
      ) : null}
      {emailedCount > 0 ? <QuoteMetaChip icon={Mail}>Emailed ×{emailedCount}</QuoteMetaChip> : null}
      {statusStr === "accepted" && quote.agreed_price != null ? (
        <QuoteMetaChip>Agreed {gbp(quote.agreed_price)}</QuoteMetaChip>
      ) : null}
      {/* Commercial has no deposit rung, so neither chip is true of it: it is
          not "awaiting" money nobody asked for, and it has not "paid" either.
          Before this it rendered "Awaiting £0 deposit" — a warning tone against
          a figure that only looks like a problem. */}
      {statusStr === "accepted" ? (
        paymentPolicy === "commercial" ? (
          <QuoteMetaChip>Business terms — invoiced on completion</QuoteMetaChip>
        ) : quote.deposit_paid_at ? (
          <QuoteMetaChip icon={CheckCircle2} tone="success">
            Deposit paid
          </QuoteMetaChip>
        ) : (
          <>
            <QuoteMetaChip tone="warn">
              Awaiting {gbp(quote.deposit_amount ?? settings.defaultDeposit)} deposit
            </QuoteMetaChip>
            {/* Beside the figure, because that is what the office is reading
                out to the customer on the phone. */}
            {paymentLink.ok ? (
              <SendPaymentLinkButton
                quoteId={quote.id}
                amount={paymentLink.amountPence / 100}
                hasEmail={!!leadOption?.email}
                hasPhone={!!leadOption?.phone}
              />
            ) : null}
          </>
        )
      ) : null}
    </>
  );

  return (
    <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <PageHeader
        eyebrow={`Quote · ${quote.quote_ref}`}
        eyebrowAccessory={headerMeta}
        title={quote.customer_name?.trim() || "New quote"}
        backHref="/quotes"
        backLabel="Quotes"
      >
        <QuoteHeaderActions
          quoteId={quote.id}
          quoteRef={quote.quote_ref ?? "—"}
          brand={quoteBrand}
          status={statusStr}
          grandTotal={Number(quote.grand_total ?? 0)}
          // `requestedDeposit` is the RESIDENTIAL rule — the small-job and
          // late-booking collapses included — so running it on a commercial
          // quote produced a figure with no meaning (25% of gross inside T-7,
          // or the whole job under the small-job threshold) and offered it to
          // the office as the deposit to request. Commercial has no rung: 0.
          //
          // Once ACCEPTED, deposit_amount is the FROZEN ask — the figure the
          // customer agreed to and the -DEP invoice bills. Recomputing it live
          // here meant a settings change after acceptance (the small-job
          // threshold especially) made "Re-send quote email" contradict both.
          // The live computation is for quotes still in flight only.
          depositAmount={
            paymentPolicy === "commercial"
              ? 0
              : statusStr === "accepted" && quote.deposit_amount != null
                ? Number(quote.deposit_amount)
                : requestedDeposit(
                    Number(quote.agreed_price ?? quote.grand_total ?? 0),
                    quote.deposit_amount ?? settings.defaultDeposit,
                    quote.moving_date,
                    settings.smallJobThreshold,
                  )
          }
          readOnly={!editing}
          editHref={`/quotes/${quote.id}?edit=1`}
          leadId={quote.lead_id}
          clientId={quote.client_id}
          lead={leadOption}
          leadStatus={leadStatus}
          leadEmail={leadOption?.email ?? null}
          values={initialValues}
          pricing={pricing}
          estimatorName={estimatorName}
          vatNumber={settings.vatNumber || undefined}
          acceptUrl={acceptUrl}
          paymentPolicy={paymentPolicy}
        />
      </PageHeader>

      {/* Where the chase engine is on this quote (renders nothing on drafts or
          once the lead has left the quoted/provisional chase window). */}
      <ChaseStatusLine
        leadStatus={leadStatus}
        chasePaused={leadChasePaused}
        quoteStatus={statusStr}
        emailSentAt={quote.email_sent_at}
        acceptedAt={quote.accepted_at}
        quoteChaseStep={leadQuoteChaseStep}
        depositChaseStep={leadDepositChaseStep}
        className="-mt-4 mb-6"
      />

      {/* Drafts open straight into the wizard (nothing to view yet); everything
          else opens as a read-only job card — Edit is a deliberate action. */}
      {editing ? (
        <QuoteBuilder
          quoteId={quote.id}
          quoteRef={quote.quote_ref}
          brand={quoteBrand}
          initialValues={initialValues}
          leadId={quote.lead_id}
          clientId={quote.client_id}
          estimatorName={estimatorName}
          estimatorId={quote.estimator_id}
          estimators={estimatorOptions}
          pricing={pricing}
          settings={settings}
          acceptUrl={acceptUrl}
          cubicHint={cubicHint}
          paymentPolicy={paymentPolicy}
        />
      ) : (
        <>
          <QuoteView
            values={initialValues}
            money={{
              subtotal: quote.subtotal,
              discount: quote.discount,
              additional_charges: quote.additional_charges,
              additional_charges_reason: quote.additional_charges_reason,
              vat_enabled: quote.vat_enabled,
              vat_amount: quote.vat_amount,
              grand_total: quote.grand_total,
              agreed_price: quote.agreed_price,
              status: quote.status ?? "draft",
              deposit_amount: quote.deposit_amount ?? settings.defaultDeposit,
              deposit_paid_at: quote.deposit_paid_at,
              moving_date: quote.moving_date,
              payment_policy: paymentPolicy,
            }}
          />
          <div className="mt-4 space-y-4">
            {quote.lead_id ? (
              <CubicSurveyCard
                leadId={quote.lead_id}
                data={cubicCard}
                leadHasEmail={!!leadOption?.email}
                recipientName={leadOption?.name ?? undefined}
              />
            ) : null}
            <ContractSignatureCard signature={contractSignature} quoteStatus={quote.status ?? "draft"} />
            <CompletionCard completion={completion} />
            <CrewNotesCard notes={crewNotes} canDelete />
          </div>
        </>
      )}
    </main>
  );
}
