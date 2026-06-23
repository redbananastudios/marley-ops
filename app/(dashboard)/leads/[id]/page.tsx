import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABELS } from "@/lib/leads/schema";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageButton } from "@/components/comms/message-button";
import { SurveyPanel } from "@/components/survey/survey-panel";
import { LeadActionBar } from "@/components/leads/lead-action-bar";
import { EditLeadDialog } from "@/components/leads/edit-lead-dialog";
import { OwnerPicker } from "@/components/leads/owner-picker";
import { StatusChanger } from "./status-changer";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A date value as YYYY-MM-DD for a date input, or "". */
function dateInput(value: string | null | undefined): string {
  if (!value) return "";
  const m = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

export const dynamic = "force-dynamic";

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtShort(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Fact({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className={mono ? "mt-0.5 break-all tabular text-xs text-foreground" : "mt-0.5 text-sm text-foreground"}>
        {value && String(value).trim() ? value : "—"}
      </p>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-12 text-center text-sm text-mist-400">{children}</p>;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: lead } = await supabase.from("leads").select("*").eq("id", id).single();
  if (!lead) notFound();

  const [{ data: client }, { data: activities }, { count: clientLeadCount }, { data: estimators }] =
    await Promise.all([
      lead.client_id
        ? supabase.from("clients").select("*").eq("id", lead.client_id).single()
        : Promise.resolve({ data: null }),
      supabase
        .from("activities")
        .select("*")
        .eq("lead_id", id)
        .order("created_at", { ascending: false }),
      lead.client_id
        ? supabase.from("leads").select("id", { count: "exact", head: true }).eq("client_id", lead.client_id)
        : Promise.resolve({ count: 0 }),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name", { ascending: true }),
    ]);
  const estimatorList = (estimators ?? []) as { id: string; full_name: string }[];

  const { data: comms } = await supabase
    .from("communications")
    .select("id, channel, to_address, subject, body, status, send_count, last_sent_at, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  const commsRows = comms ?? [];

  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, quote_ref, grand_total, status, email_send_count, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  const quoteRows = quotes ?? [];

  const { data: survey } = await supabase
    .from("surveys")
    .select("id, survey_data")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: surveyPhotos } = survey
    ? await supabase
        .from("survey_photos")
        .select("id, category, storage_path")
        .eq("survey_id", survey.id)
        .order("created_at", { ascending: true })
    : { data: [] };
  const surveyData = (survey?.survey_data ?? {}) as {
    items?: Record<string, number>;
    accessNotes?: string;
    largeItemsNotes?: string;
  };

  const activityRows = activities ?? [];
  const previousCount = (clientLeadCount ?? 1) - 1;

  const hasAttribution = Boolean(
    lead.gclid ||
      lead.gbraid ||
      lead.wbraid ||
      lead.fbclid ||
      lead.msclkid ||
      lead.utm_source ||
      lead.utm_medium ||
      lead.utm_campaign ||
      lead.utm_content ||
      lead.utm_term ||
      lead.landing_url ||
      lead.landing_referrer ||
      lead.campaign ||
      lead.variant_key,
  );

  const services = Array.isArray(lead.services) ? lead.services.filter(Boolean) : [];

  return (
    <main className="flex-1 p-6 md:p-8">
      <Link
        href="/leads"
        className="focus-ring -ml-1 mb-3 inline-flex items-center gap-0.5 rounded-sm text-sm text-mist-400 transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" strokeWidth={1.75} />
        Leads
      </Link>

      {/* Header card */}
      <Card className="mb-6 p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="eyebrow">Lead</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl text-foreground">{lead.name ?? "Unnamed lead"}</h1>
              <LeadStatusBadge status={lead.status} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EditLeadDialog
              leadId={lead.id}
              initial={{
                name: lead.name ?? "",
                phone: client?.phone_e164 ?? client?.phone_raw ?? lead.phone ?? "",
                email: client?.email ?? lead.email ?? "",
                from_postcode: lead.from_postcode ?? "",
                to_postcode: lead.to_postcode ?? "",
                from_address: lead.from_address ?? "",
                to_address: lead.to_address ?? "",
                property_size: lead.property_size ?? "",
                preferred_date: dateInput(lead.preferred_date),
                estimate_given: lead.estimate_given != null ? String(lead.estimate_given) : "",
                notes: lead.notes ?? "",
              }}
            />
            <StatusChanger leadId={lead.id} status={lead.status} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-t px-5 py-4">
          <Fact label="Entry channel" value={CHANNEL_LABELS[lead.entry_channel] ?? lead.entry_channel} />
          <div>
            <p className="eyebrow mb-1">Owner</p>
            <OwnerPicker leadId={lead.id} ownerId={lead.estimator_id} estimators={estimatorList} />
          </div>
          {lead.estimate_given != null ? <Fact label="Estimate given" value={gbp(lead.estimate_given)} /> : null}
          <Fact label="Submitted" value={fmtDate(lead.submitted_at ?? lead.created_at)} />
          {previousCount > 0 ? (
            <div>
              <p className="eyebrow">History</p>
              <p className="mt-0.5 text-sm text-mist-500">
                {previousCount} previous {previousCount === 1 ? "enquiry" : "enquiries"} from this client
              </p>
            </div>
          ) : null}
        </div>

        <LeadActionBar
          leadId={lead.id}
          phone={client?.phone_e164 ?? client?.phone_raw ?? lead.phone}
          email={client?.email ?? lead.email}
          status={lead.status}
          firstContactedAt={lead.first_contacted_at}
        />
      </Card>

      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="quotes">Quotes</TabsTrigger>
          <TabsTrigger value="survey">Survey</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="comms">Comms</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="mt-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-0">
              <div className="border-b px-5 py-3.5">
                <h2 className="font-display text-lg text-foreground">Contact</h2>
              </div>
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Fact label="Name" value={client?.display_name ?? lead.name} />
                <Fact label="Phone" value={client?.phone_e164 ?? client?.phone_raw ?? lead.phone} />
                <Fact label="Email" value={client?.email ?? lead.email} />
                <Fact label="Postcode" value={client?.postcode_home ?? lead.from_postcode} />
              </div>
            </Card>

            <Card className="p-0">
              <div className="border-b px-5 py-3.5">
                <h2 className="font-display text-lg text-foreground">Move</h2>
              </div>
              <div className="grid gap-4 p-5 sm:grid-cols-2">
                <Fact
                  label="Route"
                  value={
                    lead.from_postcode || lead.to_postcode
                      ? `${lead.from_postcode ?? "?"} → ${lead.to_postcode ?? "?"}`
                      : null
                  }
                />
                <Fact label="Property size" value={lead.property_size} />
                <Fact label="Pickup address" value={lead.from_address} />
                <Fact label="Destination address" value={lead.to_address} />
                <Fact label="Preferred date" value={fmtDate(lead.preferred_date)} />
                <Fact label="Services" value={services.length ? services.join(", ") : null} />
                <div className="sm:col-span-2">
                  <Fact label="Notes" value={lead.notes} />
                </div>
              </div>
            </Card>
          </div>

          {hasAttribution ? (
            <div className="mt-5 rounded-md bg-muted p-5">
              <p className="eyebrow mb-3">Attribution</p>
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <Fact label="gclid" value={lead.gclid} mono />
                <Fact label="gbraid" value={lead.gbraid} mono />
                <Fact label="fbclid" value={lead.fbclid} mono />
                <Fact label="utm source" value={lead.utm_source} mono />
                <Fact label="utm medium" value={lead.utm_medium} mono />
                <Fact label="utm campaign" value={lead.utm_campaign} mono />
                <Fact label="campaign" value={lead.campaign} mono />
                <Fact label="variant" value={lead.variant_key} mono />
                <Fact label="landing url" value={lead.landing_url} mono />
                <div className="sm:col-span-2 lg:col-span-3">
                  <Fact label="referrer" value={lead.landing_referrer} mono />
                </div>
              </div>
            </div>
          ) : null}
        </TabsContent>

        {/* Quotes */}
        <TabsContent value="quotes" className="mt-5">
          <Card className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <h2 className="font-display text-lg text-foreground">Quotes</h2>
              <Button asChild size="sm">
                <Link href={`/quotes/new?leadId=${lead.id}`} prefetch={false}>
                  <Plus strokeWidth={1.75} />
                  New quote
                </Link>
              </Button>
            </div>
            {quoteRows.length === 0 ? (
              <EmptyState>No quotes yet.</EmptyState>
            ) : (
              <ul className="divide-y">
                {quoteRows.map((qr) => (
                  <li key={qr.id}>
                    <Link
                      href={`/quotes/${qr.id}`}
                      className="flex items-center justify-between px-5 py-3.5 hover:bg-muted"
                    >
                      <div>
                        <p className="text-sm font-semibold text-foreground">{qr.quote_ref}</p>
                        <p className="text-xs text-mist-400">
                          {qr.status}
                          {qr.email_send_count > 0 ? ` · emailed ×${qr.email_send_count}` : ""}
                        </p>
                      </div>
                      <span className="tabular text-sm font-semibold text-foreground">
                        {qr.grand_total != null ? `£${Number(qr.grand_total).toLocaleString("en-GB")}` : "—"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>

        {/* Survey */}
        <TabsContent value="survey" className="mt-5">
          <SurveyPanel
            leadId={lead.id}
            surveyId={survey?.id ?? null}
            initialData={{
              items: surveyData.items,
              accessNotes: surveyData.accessNotes,
              largeItemsNotes: surveyData.largeItemsNotes,
            }}
            initialPhotos={(surveyPhotos ?? []) as { id: string; category: "access" | "large_items"; storage_path: string }[]}
          />
        </TabsContent>

        {/* Activity */}
        <TabsContent value="activity" className="mt-5">
          <Card className="p-0">
            {activityRows.length === 0 ? (
              <EmptyState>No activity yet.</EmptyState>
            ) : (
              <ol className="p-5">
                {activityRows.map((a, i) => (
                  <li key={a.id} className="relative flex gap-4 pb-5 last:pb-0">
                    <div className="flex flex-col items-center">
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-mist-400" aria-hidden />
                      {i < activityRows.length - 1 ? (
                        <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">{a.summary ?? a.type}</p>
                      <p className="mt-0.5 text-xs text-mist-400">{fmtShort(a.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </TabsContent>

        {/* Comms */}
        <TabsContent value="comms" className="mt-5">
          <Card className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <h2 className="font-display text-lg text-foreground">Messages</h2>
              <MessageButton
                leadId={lead.id}
                clientId={lead.client_id ?? undefined}
                defaultEmail={client?.email ?? lead.email ?? undefined}
                defaultPhone={client?.phone_e164 ?? lead.phone ?? undefined}
              />
            </div>
            {commsRows.length === 0 ? (
              <EmptyState>No messages sent yet.</EmptyState>
            ) : (
              <ul className="divide-y">
                {commsRows.map((c) => (
                  <li key={c.id} className="px-5 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">
                        <span className="uppercase text-mist-400">{c.channel}</span> · {c.to_address}
                        {c.send_count > 1 ? <span className="text-mist-400"> ×{c.send_count}</span> : null}
                      </p>
                      <span
                        className={
                          c.status === "sent"
                            ? "text-xs text-success"
                            : c.status === "failed"
                              ? "text-xs text-danger"
                              : "text-xs text-mist-400"
                        }
                      >
                        {c.status}
                      </span>
                    </div>
                    {c.subject ? <p className="mt-0.5 text-sm text-foreground">{c.subject}</p> : null}
                    <p className="mt-0.5 line-clamp-2 text-xs text-mist-400">{c.body}</p>
                    <p className="mt-1 text-xs text-mist-400">{fmtShort(c.last_sent_at ?? c.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}
