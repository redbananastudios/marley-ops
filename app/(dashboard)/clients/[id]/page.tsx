import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileDown, FileText, Phone, MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET, signatureActionLabel } from "@/lib/signatures";
import { DocumentKindPill, toDocumentKind } from "@/components/documents/document-kind-pill";
import { Card } from "@/components/ui/card";
import { BookSurveyButton } from "@/components/clients/book-survey-button";
import { ClientEditControls } from "@/components/clients/edit-client-dialog";
import { EmailComposeButton } from "@/components/comms/email-compose-dialog";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { quoteStatusDate } from "@/lib/quote/status-date";
import { UK_TZ } from "@/lib/uk-time";
import { ukPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number) ? "—" : "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: UK_TZ });
}

function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d.length >= 10 ? d : null;
}

function Fact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value && String(value).trim() ? value : "—"}</p>
    </div>
  );
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();

  const [{ data: client }, profile] = await Promise.all([
    sb.from("clients").select("*").eq("id", id).single(),
    getSessionProfile(),
  ]);
  if (!client) notFound();
  const isAdmin = profile?.role === "admin";

  const [{ data: leads }, { data: quotes }] = await Promise.all([
    sb
      .from("leads")
      .select("id, name, status, phone, email, from_postcode, to_postcode, submitted_at, created_at")
      .eq("client_id", id)
      .order("submitted_at", { ascending: false }),
    sb
      .from("quotes")
      .select("id, quote_ref, grand_total, status, created_at, email_sent_at, accepted_at, declined_at")
      .eq("client_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const leadRows = leads ?? [];
  const quoteRows = quotes ?? [];

  // Signed paperwork for this customer — the client record is the anchor for
  // "recall everything about this customer" (final-pass audit, 2026-07-10).
  // Match by client_id (canonical) OR by the client's leads (older rows).
  const leadIdList = leadRows.map((l) => l.id);
  const orFilter = leadIdList.length
    ? `client_id.eq.${id},lead_id.in.(${leadIdList.join(",")})`
    : `client_id.eq.${id}`;
  const [{ data: sigDocs }, { data: compDocs }] = await Promise.all([
    sb
      .from("signatures")
      .select("id, kind, quote_id, signer_name, channel, signed_at")
      .or(orFilter)
      .order("signed_at", { ascending: false }),
    sb
      .from("job_completions")
      .select("id, customer_name, customer_absent, exceptions, crew_name, signed_at, certificate_path")
      .or(orFilter)
      .order("signed_at", { ascending: false }),
  ]);
  const certUrl = new Map<string, string>();
  const certPaths = (compDocs ?? []).map((c) => c.certificate_path).filter(Boolean) as string[];
  if (certPaths.length) {
    const store = createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET });
    const signed = await Promise.all(
      certPaths.map((path) =>
        store.createSignedGetUrl(path, 3600).then(
          (url) => [path, url] as const,
          () => null, // drop any path whose sign fails, as before
        ),
      ),
    );
    for (const s of signed) if (s) certUrl.set(s[0], s[1]);
  }
  const quoteRefById = new Map(quoteRows.map((q) => [q.id, q.quote_ref]));
  const docCount = (sigDocs?.length ?? 0) + (compDocs?.length ?? 0);

  // Contact fallback: the one-live-client-per-phone/email dedupe means a client
  // record can carry no contact while its leads do — show the latest lead's.
  const phone =
    ukPhone(client.phone_raw ?? client.phone_e164) ??
    ukPhone(leadRows.find((l) => l.phone)?.phone ?? null);
  const email = client.email ?? leadRows.find((l) => l.email)?.email ?? null;
  const wa = waNumber(phone);

  // Their live enquiry (if any) — "Book survey" reuses it rather than duplicating.
  const OPEN = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed"];
  const openLead = leadRows.find((l) => OPEN.includes(l.status));

  const fullAddress =
    [client.address_line1, client.town, client.county, client.postcode_home, client.country]
      .filter(Boolean)
      .join(", ")
      .trim() || null;
  const secondaryEmails = (client.secondary_emails ?? []).filter(Boolean);

  return (
    <main className="flex-1 p-6 md:p-8">
      <Link href="/clients" className="focus-ring -ml-1 mb-3 inline-flex items-center gap-0.5 rounded-sm text-sm text-mist-400 transition-colors hover:text-foreground">
        <ChevronLeft className="size-4" strokeWidth={1.75} />
        Clients
      </Link>

      <Card className="mb-6 p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="eyebrow">Client</p>
            <h1 className="mt-1 flex flex-wrap items-center gap-2 font-display text-2xl font-semibold text-foreground">
              {client.display_name ?? "Unnamed client"}
              {client.is_active === false ? (
                <span className="rounded-pill bg-mist-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist-400">
                  Archived
                </span>
              ) : null}
            </h1>
          </div>
          <span className="text-sm text-mist-400">
            {leadRows.length} {leadRows.length === 1 ? "enquiry" : "enquiries"}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-4 border-t px-5 py-4">
          <Fact label="Phone" value={phone} />
          {client.alt_phone ? <Fact label="Alt phone" value={client.alt_phone} /> : null}
          <Fact label="Email" value={email} />
          {secondaryEmails.length ? <Fact label="Other emails" value={secondaryEmails.join(", ")} /> : null}
          <Fact label="Address" value={fullAddress} />
          {client.business_number ? <Fact label="Business no." value={client.business_number} /> : null}
          <Fact label="First seen" value={fmtDate(client.created_at)} />
        </div>

        <div className="flex flex-wrap gap-2 border-t px-5 py-4">
          <BookSurveyButton clientId={client.id} openLeadId={openLead?.id ?? null} />
          {/* Repeat business: start a fresh enquiry + quote for THIS customer
              without re-typing them — lands on /quotes/new pre-selected. */}
          <Link
            href={`/quotes/new?clientId=${client.id}`}
            className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <FileText className="size-4 text-mist-400" strokeWidth={1.75} />
            New quote
          </Link>
          {phone ? (
            <a href={`tel:${phone}`} className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted" aria-label="Call">
              <Phone className="size-4 text-mist-400" strokeWidth={1.75} />
              Call
            </a>
          ) : null}
          {wa ? (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted" aria-label="WhatsApp">
              <MessageCircle className="size-4 text-mist-400" strokeWidth={1.75} />
              WhatsApp
            </a>
          ) : null}
          {email ? (
            <EmailComposeButton
              to={email}
              clientId={client.id}
              label="Email"
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
            />
          ) : null}
          {/* Record management: edit the client's details, plus archive/restore (admin). */}
          <ClientEditControls client={client} isAdmin={isAdmin} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* enquiries */}
        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Enquiries</h2>
          </div>
          {leadRows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-mist-400">No enquiries.</p>
          ) : (
            <ul className="divide-y">
              {leadRows.map((l) => {
                const route =
                  l.from_postcode || l.to_postcode ? `${l.from_postcode ?? "?"} → ${l.to_postcode ?? "?"}` : "no postcodes";
                return (
                  <li key={l.id}>
                    <Link href={`/leads/${l.id}`} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{route}</p>
                        <p className="text-xs text-mist-400">{fmtDate(l.submitted_at || l.created_at)}</p>
                      </div>
                      <LeadStatusBadge status={l.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* quotes */}
        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Quotes</h2>
          </div>
          {quoteRows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-mist-400">No quotes.</p>
          ) : (
            <ul className="divide-y">
              {quoteRows.map((q) => (
                <li key={q.id}>
                  <Link href={`/quotes/${q.id}`} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{q.quote_ref}</p>
                      <p className="text-xs text-mist-400 capitalize">{q.status} · {fmtDate(quoteStatusDate(q))}</p>
                    </div>
                    <span className="tabular text-sm font-semibold text-foreground">{gbp(q.grand_total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* documents — the customer's signed paperwork file */}
      <Card className="mt-5 p-0">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Documents</h2>
          <Link href="/documents" className="focus-ring text-xs font-medium text-mist-400 hover:text-foreground">
            All documents →
          </Link>
        </div>
        {docCount === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">
            No signed documents yet — the contract lands here when a quote is accepted.
          </p>
        ) : (
          <ul className="divide-y">
            {(sigDocs ?? []).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <DocumentKindPill kind={toDocumentKind(s.kind)} />
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-foreground">
                    {signatureActionLabel(s.kind)} {s.channel === "in_person" ? "in person" : "online"} by {s.signer_name}
                  </span>
                  <span className="text-mist-400">
                    {" "}
                    · {fmtDate(s.signed_at)}
                    {s.quote_id && quoteRefById.get(s.quote_id) ? ` · ${quoteRefById.get(s.quote_id)}` : ""}
                  </span>
                </div>
                {s.quote_id ? (
                  <Link href={`/quotes/${s.quote_id}`} className="focus-ring shrink-0 text-xs font-medium text-mist-400 hover:text-foreground">
                    View →
                  </Link>
                ) : null}
              </li>
            ))}
            {(compDocs ?? []).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="shrink-0 rounded-pill bg-success-bg px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                  Completion
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-foreground">
                    {c.customer_absent ? `Crew lead ${c.crew_name} (customer not present)` : `Signed by ${c.customer_name} + ${c.crew_name}`}
                  </span>
                  <span className="text-mist-400"> · {fmtDate(c.signed_at)}</span>
                  {c.exceptions?.trim() ? (
                    <span className="ml-2 rounded-pill bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                      Exceptions noted
                    </span>
                  ) : null}
                </div>
                {c.certificate_path && certUrl.get(c.certificate_path) ? (
                  <a
                    href={certUrl.get(c.certificate_path)}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <FileDown className="size-3.5" strokeWidth={1.75} />
                    Certificate
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
