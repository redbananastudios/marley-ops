import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { sendReviewRequest } from "@/lib/comms/review-request";
import { balanceDue } from "@/lib/quote/payments";
import { acceptUrlFor, ensureAcceptToken } from "@/lib/quote/accept-flow";
import {
  CHASE_FROM,
  chaseTextToHtml,
  depositChaseEmail,
  dueChaseStep,
  DEPOSIT_CHASE_DAYS,
  expiryLabelFrom,
  isQuoteLapsed,
  quoteChaseEmail,
  QUOTE_CHASE_DAYS,
  replyAddressFor,
  type ChaseEmail,
} from "@/lib/quote/chase";
import { ukTimeAt } from "@/lib/uk-time";

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
    from: CHASE_FROM,
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

  // Chases are personal, from the lead's owner (estimator). Resolve + cache names.
  const ownerNameCache = new Map<string, string | null>();
  const ownerNameFor = async (estimatorId: string | null): Promise<string | null> => {
    if (!estimatorId) return null;
    if (ownerNameCache.has(estimatorId)) return ownerNameCache.get(estimatorId)!;
    const { data } = await sb.from("profiles").select("full_name").eq("id", estimatorId).single();
    const name = data?.full_name ?? null;
    ownerNameCache.set(estimatorId, name);
    return name;
  };

  const summary = {
    quoteChases: 0,
    depositChases: 0,
    callTasks: 0,
    lapsed: 0,
    autoCompleted: 0,
    overdueBalances: 0,
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
        const email = quoteChaseEmail(step as 1 | 2 | 3, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: await ownerNameFor(lead.estimator_id),
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
        const email = depositChaseEmail(step as 1 | 2, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
          ownerName: await ownerNameFor(lead.estimator_id),
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
        .select("id, quote_ref, agreed_price, grand_total, deposit_amount, estimator_id, client_id")
        .eq("lead_id", leadId)
        .eq("status", "accepted")
        .order("accepted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const agreed = Number(q?.agreed_price ?? q?.grand_total ?? 0);
      const deposit = Number(q?.deposit_amount ?? 0);
      const outstanding = lead.balance_paid_at ? 0 : balanceDue(agreed, deposit);

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
          ]);
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

  if (summary.errors) {
    await sendOpsAlert("Chase engine finished with errors", [
      `Today's run: ${JSON.stringify(summary)}. Check the Vercel function logs.`,
    ]);
  }
  return summary;
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
