import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { sendReviewRequest } from "@/lib/comms/review-request";
import { acceptUrlFor, ensureAcceptToken } from "@/lib/quote/accept-flow";
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
import { requestedDeposit } from "@/lib/payments-policy";
import { getBusinessSettings } from "@/lib/settings";
import { accountsFrom, ownerIdentity, type OwnerIdentity } from "@/lib/comms/sender";
import { ownerEstimatorId } from "@/lib/leads/ownership";

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
function chaseDepositLabel(quote: QuoteRow, defaultDeposit: number): string {
  const base = Number(quote.deposit_amount ?? defaultDeposit);
  if (quote.status === "accepted") return depositLabel(base);
  const agreed = Number(quote.agreed_price ?? quote.grand_total ?? 0);
  return depositLabel(requestedDeposit(agreed, base, quote.moving_date));
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
): Promise<boolean> {
  if (!lead.email) return false;
  const templateId = process.env[templateEnv];
  const res = await dispatchComm(sb, null, {
    channel: "email",
    to: lead.email,
    subject: email.subject,
    bodyText: email.text,
    ...(templateId
      ? { template: { id: templateId, variables: email.variables } }
      : { bodyHtml: chaseTextToHtml(email.text) }),
    replyTo: replyAddressFor(replyToken),
    from: email.from,
    leadId: lead.id,
    quoteId: quote.id,
    clientId: lead.client_id ?? undefined,
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
    retiredLostQuotes: 0,
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
    .select("id, lead_id, quote_ref, status, accept_token, email_sent_at, accepted_at, deposit_paid_at, moving_date, created_at, deposit_amount, agreed_price, grand_total")
    .in("lead_id", leads.map((l) => l.id))
    .in("status", ["sent", "accepted"]);
  if (quotesError) {
    log.error("cron.chase.quotes_query_failed", { error: quotesError.message });
    throw new Error(`chase: quotes query failed — ${quotesError.message}`);
  }
  const allQuotes = (quotes ?? []) as QuoteRow[];

  // Survey-derived owner fallback: a lead with no explicit estimator_id is
  // owned by whoever is assigned its booked survey — the SAME rule as the
  // "My day" cockpit and the leads "Mine" preset (lib/leads/ownership.ts),
  // so the chase voice matches who the customer actually met.
  const { data: surveyAppts } = await sb
    .from("appointments")
    .select("lead_id, estimator_id, appt_type, status")
    .in("lead_id", leads.map((l) => l.id))
    .eq("appt_type", "survey")
    .neq("status", "cancelled")
    .not("estimator_id", "is", null)
    .order("starts_at", { ascending: true });
  const surveyEstimator = new Map<string, string>();
  for (const a of surveyAppts ?? []) {
    if (a.lead_id && a.estimator_id && !surveyEstimator.has(a.lead_id)) {
      surveyEstimator.set(a.lead_id, a.estimator_id);
    }
  }
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

        const step = dueChaseStep(quote.email_sent_at, lead.quote_chase_step, QUOTE_CHASE_DAYS, now);
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
        const email = quoteChaseEmail(step as 1 | 2 | 3, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: owner.name,
          ownerEmail: owner.email,
          depositAmount: chaseDepositLabel(quote, settings.defaultDeposit),
        });
        const sent = await sendChase(sb, lead, quote, email, QUOTE_TEMPLATE_ENVS[step - 1], token);
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
      if (step && !lead.email) {
        await handToHuman(lead, quote, "no_email", "deposit");
        continue;
      }
      if (step && lead.email) {
        const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
        if (!token) continue;
        const owner = await leadOwner(lead);
        const email = depositChaseEmail(step as 1 | 2, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: owner.name,
          ownerEmail: owner.email,
          depositAmount: chaseDepositLabel(quote, settings.defaultDeposit),
        });
        const sent = await sendChase(sb, lead, quote, email, DEPOSIT_TEMPLATE_ENVS[step - 1], token);
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
          "id, quote_ref, agreed_price, grand_total, deposit_amount, deposit_paid_at, commitment_invoice_amount, commitment_paid_at, estimator_id, client_id, booking_cancelled_at",
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
      "id, lead_id, quote_ref, accept_token, accepted_at, created_at, moving_date, commitment_invoice_amount, commitment_due_date, commitment_paid_at, commitment_chase_t10_at, date_releasable_at, zoho_commitment_invoice_id, zoho_commitment_invoice_number, zoho_commitment_invoice_url",
    )
    .eq("status", "accepted")
    .is("commitment_paid_at", null)
    // Legacy iMVE imports NEVER enter the ladder: those customers booked under
    // the old system's terms (no 25%-by-T-7 promise), so a T-10 chase email or
    // a T-7 "date at risk" flag would be chasing money they never owed. All
    // their payment handling is manual (Peter, 2026-08-07).
    .neq("source", "imve")
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

        if (actions.includes("confirm_date_call")) {
          const taskOk = await ensureCommitmentCallTask(
            `Their move (${quote.moving_date}) is under 10 days away but the move date has not been confirmed yet — call to confirm the move date (${quote.quote_ref}).`,
            "confirm_date",
          );
          if (taskOk && (await stampT10())) {
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

        if (actions.includes("chase")) {
          let delivered = false;
          if (lead.email) {
            const email = composeCommitmentChaseEmail({
              firstName: lead.name,
              quoteRef: quote.quote_ref,
              amount,
              dueDate: quote.commitment_due_date,
              movingDate: quote.moving_date,
              invoiceUrl: quote.zoho_commitment_invoice_url,
              invoiceNumber: quote.zoho_commitment_invoice_number,
              todayUk: todayDay,
            });
            const templateId = process.env[COMMITMENT_CHASE_TEMPLATE_ENV];
            const res = await dispatchComm(sb, null, {
              channel: "email",
              to: lead.email,
              subject: email.subject,
              bodyText: email.text,
              ...(templateId
                ? { template: { id: templateId, variables: email.variables } }
                : { bodyHtml: email.html }),
              ...(quote.accept_token ? { replyTo: replyAddressFor(quote.accept_token) } : {}),
              from: accountsFrom(),
              leadId: lead.id,
              quoteId: quote.id,
              clientId: lead.client_id ?? undefined,
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
