import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { sendReviewRequest } from "@/lib/comms/review-request";
import { acceptUrlFor, createBalanceInvoiceFlow, ensureAcceptToken } from "@/lib/quote/accept-flow";
import {
  chaseTextToHtml,
  depositChaseEmail,
  depositLabel,
  dueChaseStep,
  dueCommitmentActions,
  DEPOSIT_CHASE_DAYS,
  expiryLabelFrom,
  isQuoteLapsed,
  postMoveOutstanding,
  quoteChaseEmail,
  QUOTE_CHASE_DAYS,
  replyAddressFor,
  type ChaseEmail,
} from "@/lib/quote/chase";
import {
  COMMITMENT_CHASE_TEMPLATE_ENV,
  composeCommitmentChaseEmail,
} from "@/lib/comms/commitment-chase-email";
import { ukTimeAt } from "@/lib/uk-time";
import { legacyLocked } from "@/lib/legacy";
import { balanceInvoiceDue } from "@/lib/payments/balance-invoice-due";
import { policyOfQuote, requestedDeposit } from "@/lib/payments-policy";
import { getBusinessSettings } from "@/lib/settings";
import { accountsFromFor, ownerIdentity, type OwnerIdentity } from "@/lib/comms/sender";
import { getBrandOrDefault, type Brand } from "@/lib/brand";
import { templateIdFor } from "@/lib/comms/template-id";
import { ownerEstimatorId } from "@/lib/leads/ownership";
import { latestAttendedSurveyAt, pendingSurveyLeadIds } from "@/lib/schedule/attended";
import { isCustomerSendHour, sendWindowReason } from "@/lib/comms/send-window";
import { sweepCommercialOverdue } from "@/lib/ops/commercial-overdue";
import { flagLeadEmailInvalid } from "@/lib/comms/invalid-email";
import {
  fetchResendSuppressions,
  planSuppressionFlags,
  type ReconcilableLead,
} from "@/lib/comms/suppressions";
import {
  planFollowUpClosures,
  type OpenFollowUp,
  type LeadState,
  type QuoteState,
} from "@/lib/follow-ups/reconcile";

/**
 * The chase engine (daily Vercel cron, ~10:00 UK). Two cadences:
 *
 *  QUOTED      — emails day 2 / 5 / 10 after the quote email; a call task in
 *                Follow-ups two days after the final email; auto-lapse to lost
 *                ("no_response") at 30 days = quote expiry.
 *  PROVISIONAL — accepted online, deposit unpaid: emails day 1 / 3 after
 *                acceptance (the day-5 call task is created at accept time).
 *
 * Stops instantly on: acceptance / lost / deposit paid (status moves the lead
 * out of scope), a customer reply (inbound webhook sets chase_paused), or the
 * chase_paused toggle. Every send is duplicate-guarded and logged in Comms +
 * the activity timeline. Sends via Resend-managed templates when the
 * RESEND_TEMPLATE_CHASE_* env ids are set, with the in-repo copy as fallback.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const QUOTE_TEMPLATE_ENVS = [
  "RESEND_TEMPLATE_CHASE_QUOTE_1",
  "RESEND_TEMPLATE_CHASE_QUOTE_2",
  "RESEND_TEMPLATE_CHASE_QUOTE_3",
] as const;
const DEPOSIT_TEMPLATE_ENVS = [
  "RESEND_TEMPLATE_CHASE_DEPOSIT_1",
  "RESEND_TEMPLATE_CHASE_DEPOSIT_2",
] as const;

interface LeadRow {
  id: string;
  client_id: string | null;
  estimator_id: string | null;
  name: string | null;
  email: string | null;
  status: string;
  chase_paused: boolean;
  quote_chase_step: number;
  deposit_chase_step: number;
}

interface QuoteRow {
  id: string;
  lead_id: string;
  quote_ref: string;
  status: string;
  /** Brand slug — resolves the chase's copy, From and template set (§3.5). */
  brand: string;
  accept_token: string | null;
  email_sent_at: string | null;
  accepted_at: string | null;
  deposit_paid_at: string | null;
  moving_date: string | null;
  created_at: string;
  deposit_amount: number | null;
  agreed_price: number | null;
  grand_total: number | null;
}

/** The deposit a chase email should quote — the live requestedDeposit for a
 *  still-sent quote (matches what /q shows if they click through today, incl.
 *  the ≤7-day late-booking collapse), the FROZEN deposit once accepted. The
 *  emails used to hardcode "£100", silently contradicting any bumped or
 *  office-set deposit (found by /qa 2026-08-05: a £300 late-booking ask whose
 *  payment email said £100). */
function chaseDepositLabel(quote: QuoteRow, defaultDeposit: number, smallJobThreshold: number): string {
  const base = Number(quote.deposit_amount ?? defaultDeposit);
  if (quote.status === "accepted") return depositLabel(base);
  const agreed = Number(quote.agreed_price ?? quote.grand_total ?? 0);
  return depositLabel(requestedDeposit(agreed, base, quote.moving_date, smallJobThreshold));
}

/** Today as a UK wall-clock yyyy-mm-dd (en-CA = ISO date format). */
const ukToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** The customer's move date has already passed — emailing them a chase reads
 *  as tone-deaf automation; a human call is the right move. */
const moveDatePassed = (movingDate: string | null): boolean =>
  !!movingDate && /^\d{4}-\d{2}-\d{2}/.test(movingDate) && movingDate.slice(0, 10) < ukToday();

/** The lead's driving quote: latest SENT for the quote chase, latest ACCEPTED
 *  for the deposit chase. */
function pickQuote(quotes: QuoteRow[], leadId: string, status: "sent" | "accepted"): QuoteRow | null {
  const mine = quotes
    .filter((q) => q.lead_id === leadId && q.status === status)
    .sort((a, b) => (b.email_sent_at ?? b.created_at).localeCompare(a.email_sent_at ?? a.created_at));
  return mine[0] ?? null;
}

async function sendChase(
  sb: ReturnType<typeof createAdminClient>,
  lead: LeadRow,
  quote: QuoteRow,
  email: ChaseEmail,
  templateEnv: string,
  replyToken: string,
  brand: Brand,
): Promise<boolean> {
  if (!lead.email) return false;
  const templateId = templateIdFor(brand, templateEnv);
  const res = await dispatchComm(sb, null, {
    channel: "email",
    to: lead.email,
    subject: email.subject,
    bodyText: email.text,
    ...(templateId
      ? { template: { id: templateId, variables: email.variables } }
      : { bodyHtml: chaseTextToHtml(email.text, brand) }),
    replyTo: replyAddressFor(replyToken, brand.name),
    from: email.from,
    leadId: lead.id,
    quoteId: quote.id,
    clientId: lead.client_id ?? undefined,
    brand,
  });
  // A duplicate-guard hit means a byte-identical message ALREADY went to this
  // customer — i.e. a prior run sent it and died before stamping the step. Treat
  // that as delivered (the same rule the commitment chase uses further down), or
  // the step is never stamped, tomorrow recomposes the identical email, the
  // guard rejects it again, and the lead is wedged on that step forever: no
  // chase 2 or 3, no final-chase call task, silence until the 30-day lapse.
  return ("ok" in res && res.ok) || ("duplicate" in res && !!res.duplicate);
}

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("chase", async () => {
  const sb = createAdminClient();
  const now = new Date();
  const settings = await getBusinessSettings(sb);

  // Chases are personal, from the lead's owner: name for the voice, login email
  // for the From address (Luke's chases send as luke@ — sender.ts ownerFrom;
  // inactive owners resolve to the house identity). Cached per run.
  const ownerCache = new Map<string, OwnerIdentity>();
  const ownerFor = async (estimatorId: string | null): Promise<OwnerIdentity> => {
    if (!estimatorId) return { name: null, email: null };
    if (ownerCache.has(estimatorId)) return ownerCache.get(estimatorId)!;
    const identity = await ownerIdentity(sb, estimatorId);
    ownerCache.set(estimatorId, identity);
    return identity;
  };

  // ONE brand resolve per slug per run (multi-brand PRD §3.5) — the quote's
  // brand drives every chase's copy, From, signature and template set.
  const brandCache = new Map<string, Brand>();
  const brandFor = async (slug: string | null | undefined): Promise<Brand> => {
    const key = slug || "marley";
    if (brandCache.has(key)) return brandCache.get(key)!;
    const brand = await getBrandOrDefault(sb, key);
    brandCache.set(key, brand);
    return brand;
  };

  const summary = {
    quoteChases: 0,
    depositChases: 0,
    callTasks: 0,
    lapsed: 0,
    autoCompleted: 0,
    overdueBalances: 0,
    commitmentChases: 0,
    commitmentCallTasks: 0,
    datesAtRisk: 0,
    balanceInvoicesRaised: 0,
    retiredLostQuotes: 0,
    closedStaleFollowUps: 0,
    skippedOutsideWindow: 0,
    suppressedLeadsFlagged: 0,
    /** Commercial credit control (PRD §3.10). Counted, never emailed to the
     *  customer — see the sweep at the end of this handler. -1 means the sweep
     *  could not read, which must not render as zero. */
    commercialOverdue: 0,
    commercialTermsMissing: 0,
    errors: 0,
  };

  // Self-heal: retire any pre-acceptance quote whose lead is already lost.
  // mark-lost and the 30-day lapse now retire quotes at the moment of loss,
  // but quotes lost BEFORE that shipped (Alex Randall MMR025, 2026-08-05) —
  // or via any future path that only touches the lead — would otherwise sit
  // on /quotes as "Awaiting reply" forever. Runs before the early return so
  // a quiet chase day still heals.
  {
    const { data: stragglers } = await sb
      .from("quotes")
      .select("id, leads!inner(status, lost_reason)")
      .in("status", ["draft", "sent"])
      .eq("leads.status", "declined")
      .limit(50);
    for (const q of stragglers ?? []) {
      const lead = (Array.isArray(q.leads) ? q.leads[0] : q.leads) as { lost_reason?: string | null } | null;
      const { error } = await sb
        .from("quotes")
        .update({
          status: "rejected",
          declined_at: now.toISOString(),
          declined_reason: lead?.lost_reason ?? "other",
        } as never)
        .eq("id", q.id)
        .in("status", ["draft", "sent"]);
      if (!error) summary.retiredLostQuotes++;
    }
  }

  // Close follow-up tasks whose work is already done. Runs BEFORE the chase
  // queries below and over ALL open tasks, not just chaseable leads — the worst
  // offenders sit on leads that have already been won, which the quoted/
  // provisional scoping would never look at.
  {
    const { data: openFus } = await sb
      .from("follow_ups")
      .select("id, lead_id, quote_id, reason, source, client_id, metadata")
      .eq("status", "open")
      .limit(500);
    const fuLeadIds = [...new Set((openFus ?? []).map((f) => f.lead_id).filter(Boolean))] as string[];
    if (fuLeadIds.length) {
      const [{ data: fuLeads }, { data: fuQuotes }] = await Promise.all([
        sb.from("leads").select("id, status, email_invalid_at").in("id", fuLeadIds),
        sb.from("quotes").select("id, lead_id, status, email_sent_at").in("lead_id", fuLeadIds),
      ]);
      const closures = planFollowUpClosures(
        (openFus ?? []) as OpenFollowUp[],
        (fuLeads ?? []) as LeadState[],
        (fuQuotes ?? []) as QuoteState[],
      );
      const fuById = new Map((openFus ?? []).map((f) => [f.id, f]));
      for (const c of closures) {
        const { data: closed } = await sb
          .from("follow_ups")
          .update({ status: "cancelled", outcome: "cancelled" })
          .eq("id", c.id)
          .eq("status", "open") // CAS: a human completing it mid-run wins
          .select("id");
        if (!closed?.length) continue;
        const fu = fuById.get(c.id);
        // Leave a trail — a task that silently vanishes is as confusing as one
        // that never closes, and the office needs to see WHY it went.
        if (fu?.lead_id) {
          await sb.from("activities").insert({
            lead_id: fu.lead_id,
            client_id: fu.client_id,
            actor_id: null,
            type: "note",
            summary: `Follow-up closed automatically — ${c.why}`,
            meta: { follow_up_id: c.id, auto: true, source: fu.source },
          });
        }
        summary.closedStaleFollowUps++;
      }
    }
  }

  // Safety net: reconcile Resend's suppression list before deciding who to
  // chase. An address on that list is one Resend will accept a send for (200,
  // with an id) and then silently drop — so without this the ladder chases into
  // a void and the lead eventually lapses to a false "lost — no response". The
  // bounce webhook normally flags these within seconds; this catches whatever it
  // missed, which between 9 Jul and 11 Aug 2026 was every single bounce (the
  // webhook was subscribed to email.received only). Runs BEFORE the leads query
  // so a lead flagged here drops out of it in the same run.
  {
    const suppressions = await fetchResendSuppressions();
    if (suppressions?.length) {
      const { data: candidates } = await sb
        .from("leads")
        .select("id, client_id, email, status, email_invalid_at")
        .is("email_invalid_at", null)
        .not("email", "is", null)
        .limit(1000);
      const flags = planSuppressionFlags(suppressions, (candidates ?? []) as ReconcilableLead[]);
      for (const flag of flags) {
        const flagged = await flagLeadEmailInvalid(sb, {
          leadId: flag.leadId,
          clientId: flag.clientId,
          toAddress: flag.email,
          kind: flag.kind,
          detail: `on Resend's suppression list (${flag.origin})`,
          at: flag.at,
          discoveredBy: "suppression-reconcile",
        });
        if (flagged) {
          summary.suppressedLeadsFlagged++;
          log.warn("cron.chase.suppressed_lead_flagged", { leadId: flag.leadId, origin: flag.origin });
        }
      }
    }
  }

  // Both driving queries are error-CHECKED and throw. Swallowing these is the
  // worst failure mode in the job: a null result silently means "nothing due
  // today" for EVERY customer — no quote chases, no deposit reminders — while
  // the run records status 'ok' with all counters at zero, indistinguishable
  // from a quiet Sunday. Throwing lets runCron mark the run failed and open the
  // cron:chase operational issue. Oldest-neglected first so that if the 200-row
  // cap is ever reached, the same leads aren't starved every single day.
  const { data: leads, error: leadsError } = await sb
    .from("leads")
    .select("id, client_id, estimator_id, name, email, status, chase_paused, quote_chase_step, deposit_chase_step")
    .in("status", ["quoted", "provisional"])
    .eq("chase_paused", false)
    .order("quote_chase_at", { ascending: true, nullsFirst: true })
    .limit(200);
  if (leadsError) {
    log.error("cron.chase.leads_query_failed", { error: leadsError.message });
    throw new Error(`chase: leads query failed — ${leadsError.message}`);
  }
  if (!leads?.length) return summary;

  const { data: quotes, error: quotesError } = await sb
    .from("quotes")
    .select("id, lead_id, quote_ref, status, brand, payment_policy, accept_token, email_sent_at, accepted_at, deposit_paid_at, moving_date, created_at, deposit_amount, agreed_price, grand_total")
    .in("lead_id", leads.map((l) => l.id))
    .in("status", ["sent", "accepted"]);
  if (quotesError) {
    log.error("cron.chase.quotes_query_failed", { error: quotesError.message });
    throw new Error(`chase: quotes query failed — ${quotesError.message}`);
  }
  // COMMERCIAL IS EXCLUDED FROM THE CHASE ENGINE ENTIRELY (PRD §3.10).
  // Filtered once, here, because this one array feeds BOTH the quote chase
  // and the deposit chase below - excluding at each loop instead would be two
  // places to forget, and the second would be silent.
  //
  // Filtered in code rather than as .neq("payment_policy","commercial") on the
  // query: in Postgres a NOT-EQUAL also drops NULLs, and payment_policy is
  // NULL on every UNACCEPTED quote - which is exactly the population the quote
  // chase exists to chase. That filter would have silently stopped chasing
  // every unaccepted residential quote.
  const allQuotes = (quotes ?? []).filter(
    (q) => policyOfQuote(q as { payment_policy?: string | null }) !== "commercial",
  ) as QuoteRow[];

  // Survey-derived owner fallback: a lead with no explicit estimator_id is
  // owned by whoever is assigned its booked survey — the SAME rule as the
  // "My day" cockpit and the leads "Mine" preset (lib/leads/ownership.ts),
  // so the chase voice matches who the customer actually met.
  // Unassigned surveys are fetched too (the owner map skips them below) because
  // the pending-visit gate cares that a visit is coming, not who is going.
  const { data: surveyAppts } = await sb
    .from("appointments")
    .select("lead_id, estimator_id, appt_type, status, starts_at")
    .in("lead_id", leads.map((l) => l.id))
    .eq("appt_type", "survey")
    .neq("status", "cancelled")
    .order("starts_at", { ascending: true });
  const surveyEstimator = new Map<string, string>();
  for (const a of surveyAppts ?? []) {
    if (a.lead_id && a.estimator_id && !surveyEstimator.has(a.lead_id)) {
      surveyEstimator.set(a.lead_id, a.estimator_id);
    }
  }
  // Chases and nudges only go out during the 09:00 UK hour, every day. The
  // crontab fires this route at BOTH 08:00 and 09:00 UTC and exactly one of them
  // is 09:00 in London all year — see lib/comms/send-window.ts. Everything else
  // in this route (the reconcile pass, retiring lost quotes, the post-move alarm,
  // the internal T-7 flag and the confirm-date nudge) runs on every invocation:
  // it is all internal and idempotent, and holding it back would just delay the
  // office's own dashboard by an hour.
  //
  // The review request at the end of the post-move sweep is deliberately NOT
  // gated: it is sent in the same breath as auto-completing the lead, and the
  // sweep never revisits a completed lead, so gating it would drop it entirely.
  // Both cron hours are a civil UK morning, so there is nothing to fix.
  const sendsAllowed = isCustomerSendHour(now);
  if (!sendsAllowed) log.info("cron.chase.sends_held", { reason: sendWindowReason(now) });

  // Leads whose survey has not happened yet — the quote ladder waits for them.
  const pendingSurvey = pendingSurveyLeadIds(surveyAppts ?? [], now);
  const lastVisitAt = latestAttendedSurveyAt(surveyAppts ?? [], now);
  /** Chase from the later of the quote email and the last visit — see the helper. */
  const ladderStart = (leadId: string, sentAt: string): string => {
    const visit = lastVisitAt.get(leadId);
    return visit && visit > sentAt ? visit : sentAt;
  };
  const leadOwner = (lead: LeadRow) =>
    ownerFor(ownerEstimatorId(lead.estimator_id, surveyEstimator.get(lead.id)));

  /** Email chasing can't (or shouldn't) run — hand the lead to a human: one
   *  open call task, chasing paused so this doesn't re-fire every morning. */
  async function handToHuman(
    lead: LeadRow,
    quote: QuoteRow,
    reason: "no_email" | "move_date_passed",
    fuReason: "quote_followup" | "deposit",
  ) {
    const { data: open } = await sb
      .from("follow_ups")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("reason", fuReason)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    const notes =
      reason === "no_email"
        ? `No email on the lead, so the automatic reminders can't run — give them a call about ${quote.quote_ref}.`
        : `Their move date (${quote.moving_date}) has passed but ${fuReason === "deposit" ? "the deposit is unpaid" : "the quote was never accepted"} — call to see where things stand.`;
    if (!open) {
      await sb.from("follow_ups").insert({
        lead_id: lead.id,
        client_id: lead.client_id,
        quote_id: quote.id,
        reason: fuReason,
        due_at: new Date().toISOString(),
        assigned_to: lead.estimator_id,
        source: "chase_engine",
        notes,
      } as never);
      summary.callTasks++;
    } else {
      await sb.from("follow_ups").update({ notes }).eq("id", open.id);
    }
    await sb.from("leads").update({ chase_paused: true } as never).eq("id", lead.id);
    await sb.from("activities").insert({
      lead_id: lead.id,
      client_id: lead.client_id,
      actor_id: null,
      type: "note",
      summary:
        reason === "no_email"
          ? `Auto-chase handed to a human — no email on the lead (${quote.quote_ref})`
          : `Auto-chase handed to a human — move date passed (${quote.quote_ref})`,
      meta: { quote_id: quote.id, auto: true, reason },
    });
  }

  for (const lead of leads as LeadRow[]) {
    try {
      /* ---------------- QUOTED: chase the acceptance ---------------- */
      if (lead.status === "quoted") {
        const quote = pickQuote(allQuotes, lead.id, "sent");
        if (!quote?.email_sent_at) continue; // never actually emailed — nothing to chase

        // A visit is still to come — say nothing until it has. Covers the lapse
        // too: auto-marking someone lost while a surveyor is booked to knock on
        // their door is worse than the chase itself.
        if (pendingSurvey.has(lead.id)) continue;

        // The CADENCE runs from this, not the raw send: a quote written a week
        // before the visit would otherwise be "day 7 old" the moment the visit
        // ends and fire its whole backlog over the next three mornings.
        // The 30-day LAPSE below deliberately stays on the send — that date is
        // printed on the customer's quote as "Valid Until" and expires their
        // accept link (acceptExpiresAt), so chasing past it would push a button
        // that no longer works.
        const chaseFrom = ladderStart(lead.id, quote.email_sent_at);

        // 30-day lapse = quote expiry → lost ("no_response"), chasing over.
        if (isQuoteLapsed(quote.email_sent_at, now)) {
          // Guard on the status-change winning: if the customer accepted between
          // the leads snapshot and now, the conditional update no-ops and we must
          // NOT cancel their fresh deposit follow-up or log a false "lapsed".
          const { data: downgraded } = await sb
            .from("leads")
            .update({
              status: "declined",
              lost_reason: "no_response",
              lost_at: now.toISOString(),
            } as never)
            .eq("id", lead.id)
            .eq("status", "quoted")
            .select("id");
          if (!downgraded?.length) continue; // lead moved on in the race window
          await sb.from("follow_ups").update({ status: "cancelled", outcome: "cancelled" })
            .eq("lead_id", lead.id).eq("status", "open");
          // Retire the quote too (same as office mark-lost) — otherwise a
          // lapsed-lost lead's quote sits on /quotes as "Awaiting reply" with
          // an escalating follow-up nudge forever, and counts in open pipeline.
          await sb.from("quotes")
            .update({
              status: "rejected",
              declined_at: now.toISOString(),
              declined_reason: "no_response",
            } as never)
            .eq("lead_id", lead.id)
            .in("status", ["draft", "sent"]);
          await sb.from("activities").insert({
            lead_id: lead.id,
            client_id: lead.client_id,
            actor_id: null,
            type: "status_change",
            summary: `Quote ${quote.quote_ref} lapsed after 30 days with no response — auto-marked lost`,
            meta: { quote_id: quote.id, auto: true, lost_reason: "no_response" },
          });
          summary.lapsed++;
          continue;
        }

        // Move date already gone → emails are the wrong tool; a human calls.
        if (moveDatePassed(quote.moving_date)) {
          await handToHuman(lead, quote, "move_date_passed", "quote_followup");
          continue;
        }

        const step = dueChaseStep(chaseFrom, lead.quote_chase_step, QUOTE_CHASE_DAYS, now);
        if (step && !sendsAllowed) {
          // Skip the send AND the stamp, so the ladder stays exactly where it is
          // and this step goes out on the in-window run instead. dueChaseStep
          // measures elapsed time, so it is still due when we come back.
          summary.skippedOutsideWindow++;
          continue;
        }
        if (!step) continue;
        // Phone-only lead: no email to chase — raise the call task instead of
        // silently skipping them forever.
        if (!lead.email) {
          await handToHuman(lead, quote, "no_email", "quote_followup");
          continue;
        }
        const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
        if (!token) continue;
        const owner = await leadOwner(lead);
        const brand = await brandFor(quote.brand);
        const email = quoteChaseEmail(step as 1 | 2 | 3, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: owner.name,
          ownerEmail: owner.email,
          depositAmount: chaseDepositLabel(quote, settings.defaultDeposit, settings.smallJobThreshold),
          brand,
        });
        const sent = await sendChase(sb, lead, quote, email, QUOTE_TEMPLATE_ENVS[step - 1], token, brand);
        if (sent) {
          // The email is already out. Losing this stamp wedges the lead on this
          // step forever (see sendChase), so a failure is counted and logged
          // rather than discarded.
          const { error: stampError } = await sb
            .from("leads")
            .update({ quote_chase_step: step, quote_chase_at: now.toISOString() } as never)
            .eq("id", lead.id);
          if (stampError) {
            summary.errors++;
            log.error("cron.chase.quote_step_stamp_failed", { leadId: lead.id, step, error: stampError.message });
          }
          await sb.from("activities").insert({
            lead_id: lead.id,
            client_id: lead.client_id,
            actor_id: null,
            type: "note",
            summary: `Auto chase ${step}/${QUOTE_CHASE_DAYS.length} sent — quote ${quote.quote_ref}`,
            meta: { quote_id: quote.id, auto: true, step },
          });
          summary.quoteChases++;

          // Final email out → a human takes over: call task two days later.
          if (step === QUOTE_CHASE_DAYS.length) {
            const { data: open } = await sb
              .from("follow_ups").select("id")
              .eq("lead_id", lead.id).eq("reason", "quote_followup").eq("status", "open")
              .limit(1).maybeSingle();
            if (!open) {
              await sb.from("follow_ups").insert({
                lead_id: lead.id,
                client_id: lead.client_id,
                quote_id: quote.id,
                reason: "quote_followup",
                due_at: ukTimeAt(9, 0, 2).toISOString(),
                assigned_to: lead.estimator_id,
                source: "chase_engine",
                notes: "Final chase email sent — give them a call.",
              } as never);
              summary.callTasks++;
            }
          }
        }
        continue;
      }

      /* ---------------- PROVISIONAL: chase the deposit ---------------- */
      const quote = pickQuote(allQuotes, lead.id, "accepted");
      if (!quote?.accepted_at || quote.deposit_paid_at) continue;

      // Accepted but the move date has slipped past with no deposit — a human calls.
      if (moveDatePassed(quote.moving_date)) {
        await handToHuman(lead, quote, "move_date_passed", "deposit");
        continue;
      }

      const step = dueChaseStep(quote.accepted_at, lead.deposit_chase_step, DEPOSIT_CHASE_DAYS, now);
      if (step && !sendsAllowed) {
        summary.skippedOutsideWindow++;
        continue;
      }
      if (step && !lead.email) {
        await handToHuman(lead, quote, "no_email", "deposit");
        continue;
      }
      if (step && lead.email) {
        const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
        if (!token) continue;
        const owner = await leadOwner(lead);
        const brand = await brandFor(quote.brand);
        const email = depositChaseEmail(step as 1 | 2, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: owner.name,
          ownerEmail: owner.email,
          depositAmount: chaseDepositLabel(quote, settings.defaultDeposit, settings.smallJobThreshold),
          brand,
        });
        const sent = await sendChase(sb, lead, quote, email, DEPOSIT_TEMPLATE_ENVS[step - 1], token, brand);
        if (sent) {
          const { error: stampError } = await sb
            .from("leads")
            .update({ deposit_chase_step: step, deposit_chase_at: now.toISOString() } as never)
            .eq("id", lead.id);
          if (stampError) {
            summary.errors++;
            log.error("cron.chase.deposit_step_stamp_failed", { leadId: lead.id, step, error: stampError.message });
          }
          await sb.from("activities").insert({
            lead_id: lead.id,
            client_id: lead.client_id,
            actor_id: null,
            type: "note",
            summary: `Auto deposit reminder ${step}/${DEPOSIT_CHASE_DAYS.length} sent — ${quote.quote_ref}`,
            meta: { quote_id: quote.id, auto: true, step },
          });
          summary.depositChases++;
        }
      }
    } catch (e) {
      summary.errors++;
      log.error("cron.chase.lead_failed", { leadId: lead.id, status: lead.status, ...errorContext(e) });
    }
  }

  /* ---------------- POST-MOVE: settle finished jobs ----------------
   * A removal whose slot ended over a day ago either completes itself (balance
   * settled → lead completed + review ask) or raises the alarm (balance still
   * unpaid after the move = money at risk → urgent task + ops alert). */
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  // 'completed' included: crew sign-off marks the appointment completed on move
  // day, and those jobs must still auto-complete the lead / chase the balance
  // (audit 2026-07-10 — scheduled-only silently skipped every signed-off job).
  // Ordered + floored, because rows never LEAVE this set: 'completed' is inside
  // the filter and an unpaid job stays 'scheduled', so without a bound the 50
  // slots silently fill with historical jobs and genuinely-new moves stop being
  // settled at all — while the run still reports success. The floor keeps the
  // window to jobs recent enough to act on (the iMVE import alone lands ~20
  // past-dated removals); oldest-first so nothing is starved indefinitely.
  const POST_MOVE_LOOKBACK_DAYS = 60;
  const lookbackFloor = new Date(now.getTime() - POST_MOVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: pastAppts, error: pastApptsError } = await sb
    .from("appointments")
    .select("id, lead_id, ends_at")
    .eq("appt_type", "removal")
    .in("status", ["scheduled", "completed"])
    .lt("ends_at", cutoff)
    .gte("ends_at", lookbackFloor)
    .not("lead_id", "is", null)
    .order("ends_at", { ascending: true })
    .limit(50);
  if (pastApptsError) {
    summary.errors++;
    log.error("cron.chase.postmove_query_failed", { error: pastApptsError.message });
  }

  for (const appt of pastAppts ?? []) {
    try {
      const leadId = appt.lead_id as string;
      const { data: lead } = await sb
        .from("leads")
        .select("id, status, client_id, name, balance_paid_at")
        .eq("id", leadId)
        .maybeSingle();
      if (!lead || lead.status !== "confirmed") continue;

      const { data: q } = await sb
        .from("quotes")
        .select(
          "id, quote_ref, payment_policy, agreed_price, grand_total, deposit_amount, deposit_paid_at, commitment_invoice_amount, commitment_paid_at, estimator_id, client_id, booking_cancelled_at",
        )
        .eq("lead_id", leadId)
        .eq("status", "accepted")
        .order("accepted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // A cancelled booking (Marley cancel that left a same-day appointment
      // behind historically) must never auto-complete, review-request, or
      // raise an OVERDUE alarm — its money lives in the refund queue.
      if (q?.booking_cancelled_at) continue;
      // COMMERCIAL never reaches the post-move sweep (PRD §3.10). Its money is
      // invoiced BY HAND on completion and settled on the client's own terms,
      // so nothing here is a fact about it.
      //
      // Without this it alarms on every commercial job, the day after every
      // move, for the FULL agreed price: postMoveOutstanding subtracts only
      // money that LANDED, and commercial has no paid deposit and no paid
      // commitment to subtract. Worse, it never stops - balance_paid_at is the
      // only thing that zeroes it, and with manual invoicing nothing in Ops
      // ever stamps it. An ops alert and an urgent task, per job, forever.
      if (policyOfQuote(q) === "commercial") continue;
      const agreed = Number(q?.agreed_price ?? q?.grand_total ?? 0);
      // Outstanding counts only money that actually LANDED (Payments Policy
      // v2): agreed − paid deposit − paid commitment, zeroed by the office's
      // balance_paid_at stamp — so a paid-commitment settled job auto-completes
      // and an unpaid one alarms with the right figure.
      const outstanding = postMoveOutstanding({
        agreed,
        depositAmount: q?.deposit_amount == null ? null : Number(q.deposit_amount),
        depositPaidAt: q?.deposit_paid_at ?? null,
        commitmentInvoiceAmount:
          q?.commitment_invoice_amount == null ? null : Number(q.commitment_invoice_amount),
        commitmentPaidAt: q?.commitment_paid_at ?? null,
        balancePaidAt: lead.balance_paid_at,
      });

      if (outstanding > 0 && q) {
        // Money at risk: the job ran but the balance never landed.
        //
        // Scoped to OUR source, not to reason='balance' generally. Raising the
        // final invoice always opens a reason='balance' task due the day BEFORE
        // the move (accept-flow createBalanceInvoiceFlow), so a lead-wide check
        // was satisfied by that pre-existing card on every invoiced job — which
        // suppressed the task, the ops alert AND the counter together, and made
        // the run read `overdueBalances: 0` as though nothing was wrong. Both
        // halves shipped in a39bf19, so this alarm had never once fired.
        const { data: open } = await sb
          .from("follow_ups")
          .select("id")
          .eq("lead_id", leadId)
          .eq("reason", "balance")
          .eq("source", "post_move_overdue")
          .eq("status", "open")
          .limit(1)
          .maybeSingle();
        const notes = `Move day has passed and £${outstanding.toFixed(2)} of the balance is still unpaid (${q.quote_ref}) — chase it today.`;
        if (!open) {
          await sb.from("follow_ups").insert({
            lead_id: leadId,
            client_id: lead.client_id,
            quote_id: q.id,
            reason: "balance",
            due_at: now.toISOString(),
            assigned_to: q.estimator_id,
            source: "post_move_overdue",
            notes,
            metadata: { amount: outstanding },
          } as never);
          await sendOpsAlert(`Balance OVERDUE after move day — ${q.quote_ref}`, [
            `<strong>${lead.name ?? "Customer"}</strong> moved but £${outstanding.toFixed(2)} of the balance is unpaid.`,
            `An urgent task is in Follow-ups; the lead stays in Bookings until it's settled.`,
          ], "money");
          summary.overdueBalances++;
        } else {
          // Already alarmed — keep the figure honest as part-payments land
          // rather than leaving a stale amount on the card.
          await sb.from("follow_ups").update({ notes, metadata: { amount: outstanding } } as never).eq("id", open.id);
        }
        // The pre-move balance card (raised at invoice time, due the day before
        // the move) is now superseded by the overdue one — close it so the board
        // shows one live item per lead instead of two.
        await sb
          .from("follow_ups")
          .update({ status: "cancelled", outcome: "cancelled" })
          .eq("lead_id", leadId)
          .eq("reason", "balance")
          .eq("status", "open")
          .neq("source", "post_move_overdue");
        continue; // never auto-complete with money outstanding
      }

      // Settled → the job is done: complete the lead + slot, ask for the review.
      await sb.from("appointments").update({ status: "completed" as never }).eq("id", appt.id);
      await sb.from("leads").update({ status: "completed" as never }).eq("id", leadId);
      await sb.from("activities").insert({
        lead_id: leadId,
        client_id: lead.client_id,
        actor_id: null,
        type: "status_change",
        summary: "Move day done and fully paid — auto-completed",
        meta: { appointment_id: appt.id, auto: true },
      });
      await sendReviewRequest(sb, leadId, null).catch(() => null);
      summary.autoCompleted++;
    } catch (e) {
      summary.errors++;
      log.error("cron.chase.postmove_failed", { appointmentId: appt.id, leadId: appt.lead_id, ...errorContext(e) });
    }
  }

  /* ---------------- COMMITMENT LADDER (Payments Policy v2): T-10 + T-7 ----
   * Confirmed bookings counting DOWN to the move (fleet-reminder style):
   *  - T-10, commitment invoice unpaid → commitment chase email (money mail,
   *    accountsFrom) + a call task; once, stamped in commitment_chase_t10_at
   *    ONLY after the send/insert succeeded (record-after-delivery rule).
   *    Date not confirmed yet at T-10 → a "confirm the move date" call task
   *    instead of any email (same one-shot stamp).
   *  - T-7, still unpaid → CAS-stamp date_releasable_at (discretion flag for
   *    the "Dates at risk" dashboard card) + activities note + money ops
   *    alert. NEVER an automatic release, never a customer email.
   * All decisions live in dueCommitmentActions (pure, UK-day maths). */
  const todayDay = ukToday();
  const horizonDay = new Date(Date.parse(`${todayDay}T00:00:00Z`) + 10 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: commitmentQuotes, error: commitmentQueryError } = await sb
    .from("quotes")
    .select(
      "id, lead_id, quote_ref, source, brand, payment_policy, standard_comms_at, accept_token, accepted_at, created_at, moving_date, commitment_invoice_amount, commitment_due_date, commitment_paid_at, commitment_chase_t10_at, date_confirm_nudge_at, date_releasable_at, zoho_commitment_invoice_id, zoho_commitment_invoice_number, zoho_commitment_invoice_url",
    )
    .eq("status", "accepted")
    .is("commitment_paid_at", null)
    // Cancelled bookings drop out of the ladder entirely: chase_paused
    // deliberately does NOT suppress the T-7 flag, so without this filter a
    // Marley-cancelled job would still stamp date_releasable_at, alert the
    // money desk and sit on "Dates at risk".
    .is("booking_cancelled_at", null)
    .gte("moving_date", todayDay)
    .lte("moving_date", horizonDay)
    .not("lead_id", "is", null)
    .limit(100);
  // A failed query must not read as a quiet day — the ladder no-oping for ALL
  // customers (e.g. code deployed before its migration) is a silent outage.
  if (commitmentQueryError) {
    summary.errors++;
    log.error("cron.chase.commitment_query_failed", { error: commitmentQueryError.message });
  }

  type CommitmentQuoteRow = NonNullable<typeof commitmentQuotes>[number];
  // One driving quote per lead: the latest accepted (supersede retires
  // siblings, but a stale duplicate must never double-chase a customer).
  const commitByLead = new Map<string, CommitmentQuoteRow>();
  for (const q of commitmentQuotes ?? []) {
    // Legacy iMVE imports stay out of the ladder until the office has informed
    // the customer by phone (standard_comms_at, Luke's T-8/9 call): they booked
    // under the old system's terms, so a T-10 chase or T-7 "date at risk" flag
    // would be chasing money they never owed (Peter, 2026-08-07 / 2026-08-13).
    if (legacyLocked(q)) continue;
    // Commercial has no 25% rung, so neither the T-10 chase nor the T-7
    // date-at-risk flag means anything for it - and both reach the customer.
    if (policyOfQuote(q) === "commercial") continue;
    const leadId = q.lead_id as string;
    const prev = commitByLead.get(leadId);
    const stamp = (row: CommitmentQuoteRow) => row.accepted_at ?? row.created_at ?? "";
    if (!prev || stamp(q) > stamp(prev)) commitByLead.set(leadId, q);
  }

  if (commitByLead.size > 0) {
    const { data: commitLeads } = await sb
      .from("leads")
      .select("id, client_id, estimator_id, name, email, chase_paused, date_confirmed_at")
      .in("id", [...commitByLead.keys()])
      .eq("status", "confirmed");
    type CommitmentLeadRow = NonNullable<typeof commitLeads>[number];
    const commitLeadById = new Map<string, CommitmentLeadRow>(
      (commitLeads ?? []).map((l) => [l.id as string, l]),
    );

    for (const quote of commitByLead.values()) {
      const lead = commitLeadById.get(quote.lead_id as string);
      if (!lead) continue; // no longer a confirmed booking — nothing to chase
      try {
        const actions = dueCommitmentActions(
          {
            movingDate: quote.moving_date,
            dateConfirmedAt: lead.date_confirmed_at,
            zohoCommitmentInvoiceId: quote.zoho_commitment_invoice_id,
            commitmentInvoiceAmount:
              quote.commitment_invoice_amount == null ? null : Number(quote.commitment_invoice_amount),
            commitmentPaidAt: quote.commitment_paid_at,
            commitmentChaseT10At: quote.commitment_chase_t10_at,
            dateConfirmNudgeAt: quote.date_confirm_nudge_at,
            dateReleasableAt: quote.date_releasable_at,
            chasePaused: lead.chase_paused,
          },
          now,
        );
        if (actions.length === 0) continue;

        const amount = Number(quote.commitment_invoice_amount ?? 0);

        /** Idempotent call task (open-row check on lead + reason 'custom' +
         *  source 'commitment_chase'). Returns true when a task exists. */
        const ensureCommitmentCallTask = async (notes: string, kind: string): Promise<boolean> => {
          const { data: open } = await sb
            .from("follow_ups")
            .select("id")
            .eq("lead_id", lead.id)
            .eq("reason", "custom")
            .eq("source", "commitment_chase")
            .eq("status", "open")
            .limit(1)
            .maybeSingle();
          if (open) {
            await sb.from("follow_ups").update({ notes }).eq("id", open.id);
            return true;
          }
          const { error: taskError } = await sb.from("follow_ups").insert({
            lead_id: lead.id,
            client_id: lead.client_id,
            quote_id: quote.id,
            reason: "custom",
            due_at: now.toISOString(),
            assigned_to: lead.estimator_id,
            source: "commitment_chase",
            notes,
            metadata: { kind, quote_ref: quote.quote_ref },
          } as never);
          if (taskError) {
            log.error("cron.chase.commitment_task_failed", {
              leadId: lead.id,
              quoteId: quote.id,
              error: taskError.message,
            });
            return false;
          }
          summary.commitmentCallTasks++;
          return true;
        };

        /** Single-winner T-10 stamp: 0 rows = another run won → skip the
         *  follow-on side effects. A DB ERROR is a failure, never "done". */
        const stampT10 = async (): Promise<boolean> => {
          const { data: won, error: stampError } = await sb
            .from("quotes")
            .update({ commitment_chase_t10_at: now.toISOString() } as never)
            .eq("id", quote.id)
            .is("commitment_chase_t10_at", null)
            .select("id");
          if (stampError) throw new Error(`commitment T-10 stamp failed: ${stampError.message}`);
          return !!won?.length;
        };

        /** Single-winner stamp for the INTERNAL confirm-date nudge. Its own
         *  column so raising it never consumes the customer commitment
         *  reminder's one-shot (they are different messages to different
         *  people). Same CAS discipline as stampT10. */
        const stampConfirmNudge = async (): Promise<boolean> => {
          const { data: won, error: stampError } = await sb
            .from("quotes")
            .update({ date_confirm_nudge_at: now.toISOString() } as never)
            .eq("id", quote.id)
            .is("date_confirm_nudge_at", null)
            .select("id");
          if (stampError) throw new Error(`confirm-date nudge stamp failed: ${stampError.message}`);
          return !!won?.length;
        };

        if (actions.includes("confirm_date_call")) {
          const taskOk = await ensureCommitmentCallTask(
            `Their move (${quote.moving_date}) is under 10 days away but the move date has not been confirmed yet — call to confirm the move date (${quote.quote_ref}).`,
            "confirm_date",
          );
          if (taskOk && (await stampConfirmNudge())) {
            await sb.from("activities").insert({
              lead_id: lead.id,
              client_id: lead.client_id,
              actor_id: null,
              type: "note",
              summary: `Confirm-the-move-date call task raised — date unconfirmed inside 10 days (${quote.quote_ref})`,
              meta: { quote_id: quote.id, auto: true, kind: "commitment_confirm_date" },
            });
          }
        }

        // The T-10 chase is one-shot, CAS-stamped after delivery, so skipping it
        // out of hours simply defers it to the in-window run — it cannot be lost.
        if (actions.includes("chase") && !sendsAllowed) summary.skippedOutsideWindow++;
        if (actions.includes("chase") && sendsAllowed) {
          let delivered = false;
          if (lead.email) {
            const brand = await brandFor(quote.brand);
            const email = composeCommitmentChaseEmail({
              firstName: lead.name,
              quoteRef: quote.quote_ref,
              amount,
              dueDate: quote.commitment_due_date,
              movingDate: quote.moving_date,
              invoiceUrl: quote.zoho_commitment_invoice_url,
              invoiceNumber: quote.zoho_commitment_invoice_number,
              todayUk: todayDay,
              brand,
            });
            const templateId = templateIdFor(brand, COMMITMENT_CHASE_TEMPLATE_ENV);
            const res = await dispatchComm(sb, null, {
              channel: "email",
              to: lead.email,
              subject: email.subject,
              bodyText: email.text,
              ...(templateId
                ? { template: { id: templateId, variables: email.variables } }
                : { bodyHtml: email.html }),
              ...(quote.accept_token ? { replyTo: replyAddressFor(quote.accept_token, brand.name) } : {}),
              from: accountsFromFor(brand),
              leadId: lead.id,
              quoteId: quote.id,
              clientId: lead.client_id ?? undefined,
              brand,
            });
            // A duplicate-guard hit means this exact email already went out (a
            // prior run sent but crashed before stamping) — safe to stamp now.
            delivered = ("ok" in res && res.ok) || ("duplicate" in res && res.duplicate);
            if (!delivered) {
              log.error("cron.chase.commitment_send_failed", {
                leadId: lead.id,
                quoteId: quote.id,
                error: "ok" in res && !res.ok ? res.error : "unknown",
              });
            }
          } else {
            delivered = true; // phone-only lead: the call task IS the chase
          }
          if (delivered) {
            await ensureCommitmentCallTask(
              `Commitment payment of £${amount.toFixed(2)} for ${quote.quote_ref} is unpaid with the move on ${quote.moving_date} — call to confirm the plan and chase the payment.`,
              "commitment_chase",
            );
            if (await stampT10()) {
              await sb.from("activities").insert({
                lead_id: lead.id,
                client_id: lead.client_id,
                actor_id: null,
                type: "note",
                summary: lead.email
                  ? `Commitment chase sent — £${amount.toFixed(2)} unpaid, move ${quote.moving_date} (${quote.quote_ref})`
                  : `Commitment chase call task raised (no email on the lead) — £${amount.toFixed(2)} unpaid, move ${quote.moving_date} (${quote.quote_ref})`,
                meta: { quote_id: quote.id, auto: true, kind: "commitment_chase", amount },
              });
              if (lead.email) summary.commitmentChases++;
            }
          }
        }

        if (actions.includes("flag")) {
          // Single-winner CAS on date_releasable_at — 0 rows means another run
          // already flagged it, so skip every side effect.
          const { data: flagged, error: flagError } = await sb
            .from("quotes")
            .update({ date_releasable_at: now.toISOString() } as never)
            .eq("id", quote.id)
            .is("date_releasable_at", null)
            .select("id");
          if (flagError) throw new Error(`date_releasable_at stamp failed: ${flagError.message}`);
          if (flagged?.length) {
            await sb.from("activities").insert({
              lead_id: lead.id,
              client_id: lead.client_id,
              actor_id: null,
              type: "note",
              summary: `Date at risk — commitment of £${amount.toFixed(2)} unpaid at 7 days before the move (${quote.quote_ref})`,
              meta: { quote_id: quote.id, auto: true, kind: "date_at_risk", amount },
            });
            await sb.from("events_log").insert({
              actor_id: null,
              entity_type: "quote",
              entity_id: quote.id,
              action: "date_releasable_flagged",
              diff: {
                quote_ref: quote.quote_ref,
                moving_date: quote.moving_date,
                unpaid_commitment: amount,
              } as never,
            });
            // The grace rule guarantees this fires ≥24h after the chase (or,
            // for a paused lead, ≥24h after confirmation) — say which, so the
            // reader knows the customer has already had their reminder.
            const chasedAt = quote.commitment_chase_t10_at
              ? new Date(quote.commitment_chase_t10_at as string).toLocaleString("en-GB", {
                  timeZone: "Europe/London",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : null;
            const appBase = (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");
            await sendOpsAlert(
              `Date at risk — commitment unpaid at 7 days (${quote.quote_ref})`,
              [
                `<strong>${lead.name ?? "Customer"}</strong> has a move on ${quote.moving_date} with £${amount.toFixed(2)} of the commitment invoice unpaid.`,
                chasedAt
                  ? `Their commitment reminder went out on ${chasedAt} and there's been no payment since.`
                  : `Chasing is paused for this lead (a conversation is in progress), so no automatic reminder has gone out — check the thread before calling.`,
                `No automatic release — the date stays booked. Review it on the dashboard ("Dates at risk"); releasing the day is a manual cancel with the standard treatment.`,
                `Lead: <a href="${appBase}/leads/${quote.lead_id}">open in Marley Ops</a>`,
              ],
              "money",
            );
            summary.datesAtRisk++;
          }
        }
      } catch (e) {
        summary.errors++;
        log.error("cron.chase.commitment_failed", {
          leadId: quote.lead_id,
          quoteId: quote.id,
          ...errorContext(e),
        });
      }
    }
  }

  /* ---------------- T-7: raise the final balance invoice ----------------
   * Final invoices were manual-only (the button on the payments card), which
   * is how Brydee (MMR034) reached move day with hers never raised. From T-7
   * the balance is due paperwork: raise + email it automatically via
   * createBalanceInvoiceFlow (CAS-claimed, Zoho-orphan safe — a hand-raised
   * invoice at a different figure refuses + alerts instead of double-billing).
   * Gated on the 09:00 UK window because it emails the customer; a gated run
   * loses nothing — zoho_balance_invoice_id stays null, so the next 09:00 run
   * picks the same candidates up. Selection rules live in
   * lib/payments/balance-invoice-due.ts (pure, tested). */
  if (sendsAllowed) {
    const t7Day = new Date(Date.parse(`${todayDay}T00:00:00Z`) + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: balQuotes, error: balQueryError } = await sb
      .from("quotes")
      .select(
        "id, quote_ref, lead_id, moving_date, source, payment_policy, standard_comms_at, zoho_balance_invoice_id, booking_cancelled_at, status, accepted_at, created_at",
      )
      .eq("status", "accepted")
      .is("zoho_balance_invoice_id", null)
      .is("booking_cancelled_at", null)
      .gte("moving_date", todayDay)
      .lte("moving_date", t7Day)
      .not("lead_id", "is", null)
      .limit(100);
    if (balQueryError) {
      // Same rule as the ladder: a failed query must not read as a quiet day.
      summary.errors++;
      log.error("cron.chase.balance_invoice_query_failed", { error: balQueryError.message });
    }

    type BalQuoteRow = NonNullable<typeof balQuotes>[number];
    // Latest accepted quote per lead — same de-dupe as the ladder, so a stale
    // duplicate can never invoice a customer twice.
    const balByLead = new Map<string, BalQuoteRow>();
    for (const q of balQuotes ?? []) {
      const leadId = q.lead_id as string;
      const prev = balByLead.get(leadId);
      const stamp = (row: BalQuoteRow) => row.accepted_at ?? row.created_at ?? "";
      if (!prev || stamp(q) > stamp(prev)) balByLead.set(leadId, q);
    }

    if (balByLead.size > 0) {
      const { data: balLeads } = await sb
        .from("leads")
        .select("id, status, balance_paid_at, date_confirmed_at")
        .in("id", [...balByLead.keys()]);
      const balLeadById = new Map((balLeads ?? []).map((l) => [l.id as string, l]));

      for (const quote of balByLead.values()) {
        const lead = balLeadById.get(quote.lead_id as string);
        if (!balanceInvoiceDue(quote, lead, todayDay, t7Day)) continue;
        try {
          const res = await createBalanceInvoiceFlow(sb, quote.id as string, null);
          if (res.ok) {
            summary.balanceInvoicesRaised++;
            log.info("cron.chase.balance_invoice_raised", { quoteRef: quote.quote_ref });
          } else if (/nothing left to invoice/i.test(res.error ?? "")) {
            // Payments already cover the price — benign, nothing to raise.
          } else {
            summary.errors++;
            log.error("cron.chase.balance_invoice_failed", {
              quoteRef: quote.quote_ref,
              error: res.error,
            });
          }
        } catch (e) {
          summary.errors++;
          log.error("cron.chase.balance_invoice_failed", {
            quoteRef: quote.quote_ref,
            ...errorContext(e),
          });
        }
      }
    }
  }

  /* ---------------- commercial credit control ----------------
   * Deliberately OUTSIDE the `sendsAllowed` window that gates every block
   * above. Those are gated because they email a CUSTOMER; this one raises an
   * internal operational issue and emails nobody — a commercial customer is
   * never chased (PRD §3.10). Gating it on the send window would make the one
   * alarm for the one ladder with no automated chase the alarm most likely to
   * be skipped. */
  {
    const sweep = await sweepCommercialOverdue(sb);
    // -1, not 0. A sweep that could not read has NOT found nothing — and this
    // summary is what the run log and the ops digest report, so a failed read
    // rendering as "0 overdue" is the precise shape of a monitor reporting good
    // news about a check that never ran.
    summary.commercialOverdue = sweep.checked ? sweep.overdue.length : -1;
    summary.commercialTermsMissing = sweep.checked ? sweep.termsMissing.length : -1;
    if (!sweep.checked) summary.errors++;
  }

  if (summary.errors) {
    await sendOpsAlert("Chase engine finished with errors", [
      `Today's run: ${JSON.stringify(summary)}. Check the Vercel function logs.`,
    ], "system");
  }
  return summary;
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
