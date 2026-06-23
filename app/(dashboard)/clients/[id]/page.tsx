import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Phone, MessageCircle, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { LeadStatusBadge } from "@/components/lead-status-badge";

export const dynamic = "force-dynamic";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number) ? "—" : "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

  const { data: client } = await sb.from("clients").select("*").eq("id", id).single();
  if (!client) notFound();

  const [{ data: leads }, { data: quotes }] = await Promise.all([
    sb
      .from("leads")
      .select("id, name, status, from_postcode, to_postcode, submitted_at, created_at")
      .eq("client_id", id)
      .order("submitted_at", { ascending: false }),
    sb
      .from("quotes")
      .select("id, quote_ref, grand_total, status, created_at")
      .eq("client_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const phone = client.phone_e164 ?? client.phone_raw;
  const email = client.email;
  const wa = waNumber(phone);
  const leadRows = leads ?? [];
  const quoteRows = quotes ?? [];

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
            <h1 className="mt-1 font-display text-2xl font-semibold text-foreground">{client.display_name ?? "Unnamed client"}</h1>
          </div>
          <span className="text-sm text-mist-400">
            {leadRows.length} {leadRows.length === 1 ? "enquiry" : "enquiries"}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-4 border-t px-5 py-4">
          <Fact label="Phone" value={phone} />
          <Fact label="Email" value={email} />
          <Fact label="Postcode" value={client.postcode_home} />
          <Fact label="First seen" value={fmtDate(client.created_at)} />
        </div>

        <div className="flex flex-wrap gap-2 border-t px-5 py-4">
          {phone ? (
            <a href={`tel:${phone}`} className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted" aria-label="Call">
              <Phone className="size-4 text-[#2563eb]" strokeWidth={1.75} />
              Call
            </a>
          ) : null}
          {wa ? (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted" aria-label="WhatsApp">
              <MessageCircle className="size-4 text-[#16a34a]" strokeWidth={1.75} />
              WhatsApp
            </a>
          ) : null}
          {email ? (
            <a href={`mailto:${email}`} className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted" aria-label="Email">
              <Mail className="size-4" strokeWidth={1.75} />
              Email
            </a>
          ) : null}
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
                      <p className="text-xs text-mist-400 capitalize">{q.status} · {fmtDate(q.created_at)}</p>
                    </div>
                    <span className="tabular text-sm font-semibold text-foreground">{gbp(q.grand_total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
