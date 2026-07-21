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
  return "ok" in res && res.ok; // a duplicate-guard hit counts as not-sent
}

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("chase", async () => {
  const sb = createAdminClient();
  const now = new Date();

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
    errors: 0,
  };

  const { data: leads } = await sb
    .from("leads")
    .select("id, client_id, estimator_id, name, email, status, chase_paused, quote_chase_step, deposit_chase_step")
    .in("status", ["quoted", "provisional"])
    .eq("chase_paused", false)
    .limit(200);
  if (!leads?.length) return summary;

  const { data: quotes } = await sb
    .from("quotes")
    .select("id, lead_id, quote_ref, status, accept_token, email_sent_at, accepted_at, deposit_paid_at, moving_date, created_at")
    .in("lead_id", leads.map((l) => l.id))
    .in("status", ["sent", "accepted"]);
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
        });
        const sent = await sendChase(sb, lead, quote, email, QUOTE_TEMPLATE_ENVS[step - 1], token);
        if (sent) {
          await sb
            .from("leads")
            .update({ quote_chase_step: step, quote_chase_at: now.toISOString() } as never)
            .eq("id", lead.id);
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
        });
        const sent = await sendChase(sb, lead, quote, email, DEPOSIT_TEMPLATE_ENVS[step - 1], token);
        if (sent) {
          await sb
            .from("leads")
            .update({ deposit_chase_step: step, deposit_chase_at: now.toISOString() } as never)
            .eq("id", lead.id);
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
  const { data: pastAppts } = await sb
    .from("appointments")
    .select("id, lead_id, ends_at")
    .eq("appt_type", "removal")
    .in("status", ["scheduled", "completed"])
    .lt("ends_at", cutoff)
    .not("lead_id", "is", null)
    .limit(50);

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
          "id, quote_ref, agreed_price, grand_total, deposit_amount, deposit_paid_at, commitment_invoice_amount, commitment_paid_at, estimator_id, client_id",
        )
        .eq("lead_id", leadId)
        .eq("status", "accepted")
        .order("accepted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
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
        const { data: open } = await sb
          .from("follow_ups")
          .select("id")
          .eq("lead_id", leadId)
          .eq("reason", "balance")
          .eq("status", "open")
          .limit(1)
          .maybeSingle();
        if (!open) {
          await sb.from("follow_ups").insert({
            lead_id: leadId,
            client_id: lead.client_id,
            quote_id: q.id,
            reason: "balance",
            due_at: now.toISOString(),
            assigned_to: q.estimator_id,
            source: "post_move_overdue",
            notes: `Move day has passed and £${outstanding.toFixed(2)} of the balance is still unpaid (${q.quote_ref}) — chase it today.`,
            metadata: { amount: outstanding },
          } as never);
          await sendOpsAlert(`Balance OVERDUE after move day — ${q.quote_ref}`, [
            `<strong>${lead.name ?? "Customer"}</strong> moved but £${outstanding.toFixed(2)} of the balance is unpaid.`,
            `An urgent task is in Follow-ups; the lead stays in Bookings until it's settled.`,
          ], "money");
          summary.overdueBalances++;
        }
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
  const { data: commitmentQuotes } = await sb
    .from("quotes")
    .select(
      "id, lead_id, quote_ref, accept_token, accepted_at, created_at, moving_date, commitment_invoice_amount, commitment_due_date, commitment_paid_at, commitment_chase_t10_at, date_releasable_at, zoho_commitment_invoice_id, zoho_commitment_invoice_number, zoho_commitment_invoice_url",
    )
    .eq("status", "accepted")
    .is("commitment_paid_at", null)
    .gte("moving_date", todayDay)
    .lte("moving_date", horizonDay)
    .not("lead_id", "is", null)
    .limit(100);

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
            await sendOpsAlert(
              `Date at risk — commitment unpaid at 7 days (${quote.quote_ref})`,
              [
                `<strong>${lead.name ?? "Customer"}</strong> has a move on ${quote.moving_date} with £${amount.toFixed(2)} of the commitment invoice unpaid.`,
                `No automatic release — the date stays booked. Review it on the dashboard ("Dates at risk"); releasing the day is a manual cancel with the standard treatment.`,
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
