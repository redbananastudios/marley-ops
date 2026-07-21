import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Clock, FileText, Mail, Plus, ScanLine } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABELS } from "@/lib/leads/schema";
import { deriveReachedStatus } from "@/lib/leads/funnel";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageButton } from "@/components/comms/message-button";
import { ChaseStatusLine } from "@/components/comms/chase-status-line";
import { LeadActionBar } from "@/components/leads/lead-action-bar";
import { PipelineStepper } from "@/components/leads/pipeline-stepper";
import { LeadFollowUpsCard } from "@/components/leads/lead-followups-card";
import { EditLeadDialog } from "@/components/leads/edit-lead-dialog";
import { SurveyPhotos } from "@/components/quote/survey-photos";
import { AddFollowUpDialog } from "@/components/leads/add-followup-dialog";
import { PaymentsCard } from "@/components/leads/payments-card";
import { CardPaymentsCard } from "@/components/leads/card-payments-card";
import {
  CompletionCard,
  ContractSignatureCard,
  type CompletionView,
  type ContractSignatureView,
} from "@/components/quote/signature-cards";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET } from "@/lib/signatures";
import { loadJobNotesForLead } from "@/lib/job-notes";
import { CrewNotesCard } from "@/components/crew-notes-card";
import { LeadClaimsCard } from "@/components/claims/lead-claims-card";
import type { ClaimChannel, ClaimStatus } from "@/lib/claims";
import { JobMediaList } from "@/components/content/job-media-list";
import { loadJobMedia } from "@/lib/content/job-media-load";
import { getBusinessSettings } from "@/lib/settings";
import { UK_TZ } from "@/lib/uk-time";
import { ukPhone } from "@/lib/phone";
import { StatusChanger } from "./status-changer";
import { ReviewRequestControl } from "./review-request-control";

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
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: UK_TZ });
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
    timeZone: UK_TZ,
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

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: lead } = await supabase.from("leads").select("*").eq("id", id).single();
  if (!lead) notFound();

  const {
    data: { user: viewer },
  } = await supabase.auth.getUser();
  const { data: viewerProfile } = viewer
    ? await supabase.from("profiles").select("role").eq("id", viewer.id).single()
    : { data: null };
  const isAdminViewer = viewerProfile?.role === "admin";

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

  // Estimator is survey-derived: whoever is assigned the booked survey. Read-only
  // here and only shown once a survey exists (no estimator at the enquiry stage).
  const { data: surveyAppt } = await supabase
    .from("appointments")
    .select("estimator_id, starts_at")
    .eq("lead_id", id)
    .eq("appt_type", "survey")
    .neq("status", "cancelled")
    .not("estimator_id", "is", null)
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const profileName = new Map(estimatorList.map((p) => [p.id, p.full_name]));
  const surveyEstimatorName = surveyAppt?.estimator_id
    ? (profileName.get(surveyAppt.estimator_id) ?? "Estimator")
    : null;

  // Latest survey record (photos hang off it; created lazily on first upload).
  const { data: surveyRow } = await supabase
    .from("surveys")
    .select("id, status, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: comms } = await supabase
    .from("communications")
    .select("id, channel, to_address, subject, body, status, send_count, last_sent_at, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  const commsRows = comms ?? [];

  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, quote_ref, grand_total, agreed_price, status, email_send_count, email_sent_at, accepted_at, created_at")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  const quoteRows = quotes ?? [];

  // The chase-engine driver: the latest SENT quote while "quoted", the latest
  // ACCEPTED quote while chasing the deposit ("provisional"). quoteRows is newest
  // first, so .find picks the latest match. Feeds the Comms-tab chase line.
  const chaseQuote =
    lead.status === "quoted"
      ? quoteRows.find((q) => q.status === "sent")
      : lead.status === "provisional"
        ? quoteRows.find((q) => q.status === "accepted")
        : null;

  // Open follow-ups for THIS lead — the compact strip on Overview. Assigned name
  // resolves off the active-profiles map already loaded (cheap; null if not there).
  const { data: followUpRows } = await supabase
    .from("follow_ups")
    .select("id, reason, due_at, attempt_count, assigned_to, notes")
    .eq("lead_id", id)
    .eq("status", "open")
    .order("due_at", { ascending: true });
  const leadFollowUps = (followUpRows ?? []).map((f) => ({
    id: f.id,
    reason: f.reason,
    dueAt: f.due_at,
    attempts: f.attempt_count ?? 0,
    assignedName: f.assigned_to ? (profileName.get(f.assigned_to) ?? null) : null,
    notes: f.notes,
  }));

  // Signed paperwork on this enquiry (final-pass audit: the lead page is where
  // the office lands from Leads/Board/Follow-ups — evidence must show here,
  // not just on the quote page).
  const [{ data: sigRow }, { data: completionRow }, crewNotes, jobMedia, { data: claimRows }] = await Promise.all([
    supabase
      .from("signatures")
      .select("signer_name, signature_data, method, channel, acknowledgments, terms_version, signed_at")
      .eq("lead_id", id)
      .eq("kind", "contract")
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("job_completions")
      .select(
        "id, customer_name, customer_absent, absent_reason, exceptions, crew_name, signed_at, certificate_emailed_at, certificate_path",
      )
      .eq("lead_id", id)
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    loadJobNotesForLead(createAdminClient(), id),
    loadJobMedia({ leadId: id, limit: 40 }),
    supabase
      .from("claims")
      .select("id, claim_no, status, reported_at, reported_channel, description")
      .eq("lead_id", id)
      .order("reported_at", { ascending: false }),
  ]);
  const leadClaims = (claimRows ?? []).map((c) => ({
    id: c.id,
    claimNo: c.claim_no,
    status: c.status as ClaimStatus,
    reportedAt: c.reported_at,
    reportedChannel: c.reported_channel as ClaimChannel,
    description: c.description,
  }));

  let leadCompletion: CompletionView | null = null;
  if (completionRow) {
    let certificateUrl: string | null = null;
    if (completionRow.certificate_path) {
      certificateUrl = await createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET })
        .createSignedGetUrl(completionRow.certificate_path, 3600)
        .catch(() => null);
    }
    const { certificate_path, ...rest } = completionRow;
    leadCompletion = { ...rest, certificateUrl, hasStoredCertificate: !!certificate_path };
  }
  const leadContract = (sigRow ?? null) as ContractSignatureView | null;

  // Payments context: standard deposit from Settings + the accepted quote's value.
  const settings = await getBusinessSettings(supabase);
  const { defaultDeposit } = settings;
  const acceptedQuote = quoteRows.find((q) => q.status === "accepted");
  const agreedPrice = acceptedQuote
    ? Number(acceptedQuote.agreed_price ?? acceptedQuote.grand_total ?? 0) || null
    : null;

  // A lost lead reads as "declined" with no memory of how far it got, so the
  // stepper's trail is inferred from its artefacts (survey / sent / accepted /
  // deposit). Only needed for the declined case; live statuses drive themselves.
  const reachedStatus =
    lead.status === "declined"
      ? deriveReachedStatus({
          hasSurvey: !!surveyAppt || !!surveyRow,
          hasSentQuote: quoteRows.some((q) =>
            ["sent", "accepted", "rejected", "superseded"].includes(q.status),
          ),
          hasAcceptedQuote: !!acceptedQuote,
          depositPaid: !!lead.deposit_paid_at,
        })
      : null;
  // Payments matter once the job is real (or once any payment state exists).
  const showPayments =
    ["confirmed", "completed"].includes(lead.status) ||
    lead.deposit_amount != null ||
    lead.balance_amount != null;

  // Card-payment ledger (takepayments attempts) — newest first.
  const { data: cardPaymentRows } = await createAdminClient()
    .from("card_payments")
    .select(
      "id, status, amount_pence, refunded_pence, card_number_mask, card_scheme, created_at, settled_at, refund_reason",
    )
    .eq("lead_id", id)
    .order("created_at", { ascending: false });
  const cardPayments = (cardPaymentRows ?? [])
    .filter((r) => r.status !== "abandoned")
    .map((r) => ({
      id: r.id,
      status: r.status,
      amountPence: r.amount_pence,
      refundedPence: r.refunded_pence,
      cardNumberMask: r.card_number_mask,
      cardScheme: r.card_scheme,
      createdAt: r.created_at,
      settledAt: r.settled_at,
      refundReason: r.refund_reason,
    }));

  const activityRows = activities ?? [];
  const previousCount = (clientLeadCount ?? 1) - 1;

  // Always visible on the lead — hiding it until acceptance meant the office
  // couldn't find the switch when they went looking (Peter, 2026-07-14). The
  // copy already reads correctly pre-acceptance ("sends automatically once the
  // move is complete"). When switched off, the "why/when" line comes from the
  // latest suppression activity (already loaded).
  const showReviewControl = true;
  const suppressionActivity = lead.review_suppressed
    ? (activityRows.find((a) => typeof a.summary === "string" && a.summary.startsWith("Review request switched off")) ??
      null)
    : null;

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
                phone: ukPhone(client?.phone_raw ?? client?.phone_e164 ?? lead.phone) ?? "",
                email: client?.email ?? lead.email ?? "",
                from_postcode: lead.from_postcode ?? "",
                to_postcode: lead.to_postcode ?? "",
                from_address: lead.from_address ?? "",
                to_address: lead.to_address ?? "",
                property_size: lead.property_size ?? "",
                preferred_date: dateInput(lead.preferred_date),
                estimate_given: lead.estimate_given != null ? String(lead.estimate_given) : "",
                referral_commission:
                  lead.referral_commission != null ? String(lead.referral_commission) : "",
                notes: lead.notes ?? "",
              }}
            />
            <AddFollowUpDialog leadId={lead.id} />
            <StatusChanger leadId={lead.id} status={lead.status} />
          </div>
        </div>

        <div className="border-t px-5 py-3">
          <PipelineStepper status={lead.status} leadId={lead.id} reachedStatus={reachedStatus} />
        </div>

        <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-t px-5 py-4">
          <Fact label="Entry channel" value={CHANNEL_LABELS[lead.entry_channel] ?? lead.entry_channel} />
          {surveyEstimatorName ? <Fact label="Estimator" value={surveyEstimatorName} /> : null}
          {lead.estimate_given != null ? <Fact label="Estimate given" value={gbp(lead.estimate_given)} /> : null}
          {Number(lead.referral_commission) > 0 ? (
            <Fact label="3rd-party commission" value={gbp(Number(lead.referral_commission))} />
          ) : null}
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
          phone={ukPhone(client?.phone_raw ?? client?.phone_e164 ?? lead.phone)}
          email={client?.email ?? lead.email}
          status={lead.status}
          firstContactedAt={lead.first_contacted_at}
          quotes={quoteRows.map((q) => ({
            id: q.id,
            quote_ref: q.quote_ref,
            grand_total: q.grand_total,
            status: q.status,
          }))}
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
                <Fact label="Phone" value={ukPhone(client?.phone_raw ?? client?.phone_e164 ?? lead.phone)} />
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

          {leadFollowUps.length ? (
            <div className="mt-5">
              <LeadFollowUpsCard rows={leadFollowUps} />
            </div>
          ) : null}

          {showPayments ? (
            <div className="mt-5">
              <PaymentsCard
                leadId={lead.id}
                defaultDeposit={defaultDeposit}
                agreedPrice={agreedPrice}
                state={{
                  depositAmount: lead.deposit_amount != null ? Number(lead.deposit_amount) : null,
                  depositRequestedAt: lead.deposit_requested_at,
                  depositPaidAt: lead.deposit_paid_at,
                  balanceAmount: lead.balance_amount != null ? Number(lead.balance_amount) : null,
                  balanceDueDate: lead.balance_due_date,
                  balancePaidAt: lead.balance_paid_at,
                }}
              />
            </div>
          ) : null}

          {cardPayments.length ? (
            <div className="mt-5">
              <CardPaymentsCard rows={cardPayments} isAdmin={isAdminViewer} />
            </div>
          ) : null}

          {leadContract || leadCompletion ? (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <ContractSignatureCard
                signature={leadContract}
                quoteStatus={acceptedQuote ? "accepted" : "none"}
              />
              <CompletionCard completion={leadCompletion} />
            </div>
          ) : acceptedQuote ? (
            <div className="mt-5">
              <ContractSignatureCard signature={null} quoteStatus="accepted" />
            </div>
          ) : null}

          {showReviewControl ? (
            <div className="mt-5">
              <ReviewRequestControl
                leadId={lead.id}
                reviewRequestedAt={lead.review_requested_at}
                reviewSuppressed={lead.review_suppressed}
                suppressionNote={
                  suppressionActivity
                    ? { summary: suppressionActivity.summary ?? "", at: suppressionActivity.created_at }
                    : null
                }
              />
            </div>
          ) : null}

          {/* A claim can follow any finished job — including one completed
              without a panel sign-off (legacy/backfilled moves), so status
              alone is enough to surface the card. */}
          {leadCompletion || leadClaims.length || lead.status === "completed" ? (
            <div className="mt-5">
              <LeadClaimsCard leadId={lead.id} claims={leadClaims} />
            </div>
          ) : null}

          {crewNotes.length ? (
            <div className="mt-5">
              <CrewNotesCard notes={crewNotes} canDelete />
            </div>
          ) : null}

          {jobMedia.length ? (
            <div className="mt-5 rounded-lg border border-border bg-card">
              <div className="border-b px-4 py-3">
                <p className="eyebrow">Job content</p>
                <p className="mt-0.5 text-xs text-mist-400">
                  Captured on the job — approve items to make them usable for marketing.
                </p>
              </div>
              <JobMediaList items={jobMedia} />
            </div>
          ) : null}

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
            <p className="border-b bg-muted/30 px-5 py-2.5 text-xs text-mist-400">
              The site survey lives inside the quote — access and large-item notes &amp; photos are
              captured in the quote builder (steps 4 &amp; 6).
            </p>
            {quoteRows.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No quotes yet"
                hint="Use New quote above to price this move and send it to the customer."
              />
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
          {settings.aiSurveyEnabled ? (
            <Card className="mb-5 overflow-hidden border-mm-red/25 bg-[#111719] p-0 text-white shadow-lg">
              <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-center md:p-6">
                <div className="flex min-w-0 items-start gap-4">
                  <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-mm-red text-white shadow-[0_0_24px_rgba(192,56,56,.3)]">
                    <ScanLine className="size-6" strokeWidth={1.8} />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-xl font-semibold">AI video survey</h2>
                      <span className="rounded-pill bg-cyan-300/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-200">Estimator tool</span>
                    </div>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-white/65">
                      Record each room, let AI prepare the moving inventory, then verify every item before calculating volume and vehicle requirements.
                    </p>
                  </div>
                </div>
                <Button asChild className="min-h-12 bg-mm-red px-5 text-white hover:bg-mm-red-deep">
                  <Link href={`/leads/${lead.id}/cubic`}>
                    <ScanLine strokeWidth={1.75} />
                    Open AI survey
                  </Link>
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="mb-5 p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
              <h2 className="font-display text-lg text-foreground">Survey visit</h2>
              {!surveyAppt ? (
                <Button asChild size="sm">
                  <Link href={`/schedule/surveys?leadId=${lead.id}`}>
                    <Plus strokeWidth={1.75} />
                    Book survey
                  </Link>
                </Button>
              ) : null}
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <Fact label="Booked for" value={surveyAppt ? fmtShort(surveyAppt.starts_at) : "Not booked"} />
              <Fact label="Estimator" value={surveyEstimatorName} />
              <Fact label="Survey record" value={surveyRow ? `${surveyRow.status} · ${fmtDate(surveyRow.created_at)}` : "Starts with the first photo"} />
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-5">
              <SurveyPhotos leadId={lead.id} category="access" label="Access" />
            </Card>
            <Card className="p-5">
              <SurveyPhotos leadId={lead.id} category="large_items" label="Large items / extra packing" />
            </Card>
          </div>
          <p className="mt-3 text-xs text-mist-400">
            These are the same photos as the quote builder&apos;s steps 4 &amp; 6 — added here or there, they stay together on the lead.
          </p>
        </TabsContent>

        {/* Activity */}
        <TabsContent value="activity" className="mt-5">
          <Card className="p-0">
            {activityRows.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="No activity yet"
                hint="Calls, quotes and emails on this lead will appear here as they happen."
              />
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
          <ChaseStatusLine
            leadStatus={lead.status}
            chasePaused={lead.chase_paused ?? false}
            quoteStatus={chaseQuote?.status ?? null}
            emailSentAt={chaseQuote?.email_sent_at ?? null}
            acceptedAt={chaseQuote?.accepted_at ?? null}
            quoteChaseStep={lead.quote_chase_step ?? 0}
            depositChaseStep={lead.deposit_chase_step ?? 0}
            className="mb-3"
          />
          <Card className="p-0">
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <h2 className="font-display text-lg text-foreground">Messages</h2>
              <MessageButton
                leadId={lead.id}
                clientId={lead.client_id ?? undefined}
                defaultEmail={client?.email ?? lead.email ?? undefined}
                defaultPhone={ukPhone(client?.phone_raw ?? client?.phone_e164 ?? lead.phone) ?? undefined}
              />
            </div>
            {commsRows.length === 0 ? (
              <EmptyState
                icon={Mail}
                title="No messages yet"
                hint="Emails and texts sent from here are logged on this timeline."
              />
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
