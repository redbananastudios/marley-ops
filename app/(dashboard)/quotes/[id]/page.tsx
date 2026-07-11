import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardCheck, Boxes } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { normalizeQuoteValues } from "@/lib/quote/form-types";
import { getPricingConfig } from "@/lib/quote/pricing-config";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { ensureAcceptToken, acceptUrlFor } from "@/lib/quote/accept-flow";
import { QuoteBuilder, QuoteStatusBadge } from "@/components/quote/quote-builder";
import type { CubicQuoteHint } from "@/components/quote/wizard-steps";
import { computeCubicTotals, recommendVans, sanitizeCubicLines, vehicleShortLabel } from "@/lib/cubic-survey";
import { CubicSurveyCard, type CubicCardData } from "@/components/cubic/cubic-survey-card";
import { QuoteView } from "@/components/quote/quote-view";
import {
  CompletionCard,
  ContractSignatureCard,
  type CompletionView,
  type ContractSignatureView,
} from "@/components/quote/signature-cards";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadJobNotesForLead, type JobNoteView } from "@/lib/job-notes";
import { CrewNotesCard } from "@/components/crew-notes-card";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
import { RejectQuoteButton } from "@/components/quote/reject-quote-button";
import { DeleteQuoteButton } from "@/components/quote/delete-quote-button";
import { ViewLeadDialog } from "@/components/quote/view-lead-dialog";

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
      "id, quote_ref, status, grand_total, agreed_price, accepted_at, state_blob, lead_id, client_id, email_send_count, customer_name, deposit_amount, deposit_paid_at, subtotal, discount, vat_enabled, vat_amount, moving_date",
    )
    .eq("id", id)
    .maybeSingle();

  if (!quote) notFound();

  // Estimator name for the PDF "Prepared by" line.
  const {
    data: { user },
  } = await sb.auth.getUser();
  const estimatorName =
    (user?.user_metadata?.full_name as string | undefined) ?? user?.email ?? null;

  const initialValues = normalizeQuoteValues(quote.state_blob);
  const [pricing, settings] = await Promise.all([getPricingConfig(sb), getBusinessSettings(sb)]);
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
      .select("total_ft3, items, status")
      .eq("lead_id", quote.lead_id)
      .maybeSingle();
    if (cubic) {
      const totalFt3 = Number(cubic.total_ft3) || 0;
      const rec =
        totalFt3 > 0
          ? recommendVans(totalFt3, {
              fillPct: settings.cubicFillPct,
              transitFt3: settings.cubicTransitFt3,
              lutonFt3: settings.cubicLutonFt3,
              sevenFiveTFt3: settings.cubic75tFt3,
            })
          : null;
      const totals = computeCubicTotals(sanitizeCubicLines(cubic.items) ?? []);
      cubicCard = {
        totalFt3,
        vanLabel: rec ? vehicleShortLabel(rec) : null,
        itemCount: totals.itemCount,
        status: cubic.status ?? "draft",
        hasSurvey: true,
      };
      if (rec) {
        cubicHint = {
          totalFt3,
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
        const { data: signed } = await createAdminClient()
          .storage.from("job-docs")
          .createSignedUrl(comp.certificate_path, 3600);
        certificateUrl = signed?.signedUrl ?? null;
      }
      const { certificate_path, ...rest } = comp;
      completion = { ...rest, certificateUrl, hasStoredCertificate: !!certificate_path };
    }
  }

  // The linked lead's context for the View-lead modal (no navigation away from the form).
  let leadOption = null;
  let leadStatus: string | null = null;
  if (quote.lead_id) {
    const { data: lead } = await sb
      .from("leads")
      .select(
        "id,name,phone,email,status,from_postcode,from_address,to_postcode,to_address,property_size,notes,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign",
      )
      .eq("id", quote.lead_id)
      .maybeSingle();
    if (lead) {
      const { notes, status, ...l } = lead;
      leadStatus = status;
      leadOption = { ...l, lead_notes: notes, source: classifySource(l as unknown as LeadLite) };
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <PageHeader
        eyebrow={`Quote · ${quote.quote_ref}`}
        title={quote.customer_name?.trim() || "New quote"}
        backHref="/quotes"
        backLabel="Quotes"
      >
        <div className="flex items-center gap-3">
          {leadOption ? <ViewLeadDialog lead={leadOption} status={leadStatus} /> : null}
          {quote.lead_id ? (
            <Link
              href={`/leads/${quote.lead_id}/cubic`}
              className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-muted"
            >
              <Boxes className="size-3.5 text-mm-red" strokeWidth={2} />
              Cubic survey
            </Link>
          ) : null}
          {emailedCount > 0 ? (
            <span className="rounded-pill bg-success-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
              Emailed ×{emailedCount}
            </span>
          ) : null}
          {quote.status === "accepted" && quote.agreed_price != null ? (
            <span className="rounded-pill bg-success-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
              Agreed {gbp(quote.agreed_price)}
            </span>
          ) : null}
          {quote.status === "accepted" ? (
            <Link
              href="/bookings"
              className={`focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold ${
                quote.deposit_paid_at
                  ? "border-success-border bg-success-bg text-success"
                  : "border-warn-border bg-warn-bg text-warn"
              }`}
            >
              <ClipboardCheck className="size-3.5" strokeWidth={2} />
              {quote.deposit_paid_at
                ? "Deposit paid · Bookings"
                : `Awaiting ${gbp(quote.deposit_amount ?? settings.defaultDeposit)} deposit · Bookings`}
            </Link>
          ) : null}
          <QuoteStatusBadge status={quote.status ?? "draft"} />
          <AcceptQuoteButton
            quoteId={quote.id}
            grandTotal={Number(quote.grand_total ?? 0)}
            status={quote.status ?? "draft"}
            depositAmount={settings.defaultDeposit}
          />
          <RejectQuoteButton quoteId={quote.id} status={quote.status ?? "draft"} />
          <DeleteQuoteButton
            quoteId={quote.id}
            status={quote.status ?? "draft"}
            quoteRef={quote.quote_ref ?? "—"}
          />
        </div>
      </PageHeader>

      {/* Drafts open straight into the wizard (nothing to view yet); everything
          else opens as a read-only job card — Edit is a deliberate action. */}
      {quote.status === "draft" || sp.edit === "1" ? (
        <QuoteBuilder
          quoteId={quote.id}
          quoteRef={quote.quote_ref}
          initialValues={initialValues}
          leadId={quote.lead_id}
          clientId={quote.client_id}
          estimatorName={estimatorName}
          pricing={pricing}
          settings={settings}
          acceptUrl={acceptUrl}
          cubicHint={cubicHint}
        />
      ) : (
        <>
          <QuoteView
            values={initialValues}
            money={{
              subtotal: quote.subtotal,
              discount: quote.discount,
              vat_enabled: quote.vat_enabled,
              vat_amount: quote.vat_amount,
              grand_total: quote.grand_total,
              agreed_price: quote.agreed_price,
              status: quote.status ?? "draft",
              deposit_amount: quote.deposit_amount ?? settings.defaultDeposit,
              deposit_paid_at: quote.deposit_paid_at,
              moving_date: quote.moving_date,
            }}
            editHref={`/quotes/${quote.id}?edit=1`}
          />
          <div className="mt-4 space-y-4">
            {quote.lead_id ? <CubicSurveyCard leadId={quote.lead_id} data={cubicCard} /> : null}
            <ContractSignatureCard signature={contractSignature} quoteStatus={quote.status ?? "draft"} />
            <CompletionCard completion={completion} />
            <CrewNotesCard notes={crewNotes} canDelete />
          </div>
        </>
      )}
    </main>
  );
}
