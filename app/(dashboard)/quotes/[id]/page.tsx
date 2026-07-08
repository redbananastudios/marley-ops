import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { normalizeQuoteValues } from "@/lib/quote/form-types";
import { getPricingConfig } from "@/lib/quote/pricing-config";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { QuoteBuilder, QuoteStatusBadge } from "@/components/quote/quote-builder";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
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
export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();

  const { data: quote } = await sb
    .from("quotes")
    .select(
      "id, quote_ref, status, grand_total, agreed_price, accepted_at, state_blob, lead_id, client_id, email_send_count, customer_name",
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
          <QuoteStatusBadge status={quote.status ?? "draft"} />
          <AcceptQuoteButton
            quoteId={quote.id}
            grandTotal={Number(quote.grand_total ?? 0)}
            status={quote.status ?? "draft"}
          />
          <DeleteQuoteButton
            quoteId={quote.id}
            status={quote.status ?? "draft"}
            quoteRef={quote.quote_ref ?? "—"}
          />
        </div>
      </PageHeader>

      <QuoteBuilder
        quoteId={quote.id}
        quoteRef={quote.quote_ref}
        initialValues={initialValues}
        leadId={quote.lead_id}
        clientId={quote.client_id}
        estimatorName={estimatorName}
        pricing={pricing}
        settings={settings}
      />
    </main>
  );
}
