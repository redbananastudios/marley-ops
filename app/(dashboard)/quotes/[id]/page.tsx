import Link from "next/link";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { normalizeQuoteValues } from "@/lib/quote/form-types";
import { QuoteBuilder, QuoteStatusBadge } from "@/components/quote/quote-builder";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
import { DeleteQuoteButton } from "@/components/quote/delete-quote-button";

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
  const emailedCount = quote.email_send_count ?? 0;

  return (
    <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <PageHeader
        eyebrow={`Quote · ${quote.quote_ref}`}
        title={quote.customer_name?.trim() || "New quote"}
        backHref="/quotes"
        backLabel="Quotes"
      >
        <div className="flex items-center gap-3">
          {quote.lead_id ? (
            <Link
              href={`/leads/${quote.lead_id}`}
              className="focus-ring inline-flex items-center gap-1 rounded-sm text-sm text-mist-400 transition-colors hover:text-foreground"
            >
              <Users className="size-4" strokeWidth={1.75} />
              View lead
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
          <span className="tabular font-display text-xl font-bold text-foreground">
            {gbp(quote.grand_total)}
          </span>
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
      />
    </main>
  );
}
