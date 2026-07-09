import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { acceptUrlFor, ensureAcceptToken } from "@/lib/quote/accept-flow";
import {
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
  created_at: string;
}

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
    from: "Connor at Marley Moves <quotes@marleymoves.co.uk>",
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
  const sb = createAdminClient();
  const now = new Date();
  const summary = { quoteChases: 0, depositChases: 0, callTasks: 0, lapsed: 0, errors: 0 };

  const { data: leads } = await sb
    .from("leads")
    .select("id, client_id, estimator_id, name, email, status, chase_paused, quote_chase_step, deposit_chase_step")
    .in("status", ["quoted", "provisional"])
    .eq("chase_paused", false)
    .limit(200);
  if (!leads?.length) return NextResponse.json({ ok: true, ...summary });

  const { data: quotes } = await sb
    .from("quotes")
    .select("id, lead_id, quote_ref, status, accept_token, email_sent_at, accepted_at, deposit_paid_at, created_at")
    .in("lead_id", leads.map((l) => l.id))
    .in("status", ["sent", "accepted"]);
  const allQuotes = (quotes ?? []) as QuoteRow[];

  for (const lead of leads as LeadRow[]) {
    try {
      /* ---------------- QUOTED: chase the acceptance ---------------- */
      if (lead.status === "quoted") {
        const quote = pickQuote(allQuotes, lead.id, "sent");
        if (!quote?.email_sent_at) continue; // never actually emailed — nothing to chase

        // 30-day lapse = quote expiry → lost ("no_response"), chasing over.
        if (isQuoteLapsed(quote.email_sent_at, now)) {
          await sb
            .from("leads")
            .update({
              status: "declined",
              lost_reason: "no_response",
              lost_at: now.toISOString(),
            } as never)
            .eq("id", lead.id)
            .eq("status", "quoted");
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

        const step = dueChaseStep(quote.email_sent_at, lead.quote_chase_step, QUOTE_CHASE_DAYS, now);
        if (!step || !lead.email) continue;
        const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
        if (!token) continue;
        const email = quoteChaseEmail(step as 1 | 2 | 3, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
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

      const step = dueChaseStep(quote.accepted_at, lead.deposit_chase_step, DEPOSIT_CHASE_DAYS, now);
      if (step && lead.email) {
        const token = quote.accept_token ?? (await ensureAcceptToken(sb, quote.id));
        if (!token) continue;
        const email = depositChaseEmail(step as 1 | 2, {
          firstName: lead.name,
          quoteRef: quote.quote_ref,
          acceptUrl: acceptUrlFor(token),
          expiryLabel: expiryLabelFrom(quote.email_sent_at, quote.created_at),
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
    } catch {
      summary.errors++;
    }
  }

  if (summary.errors) {
    await sendOpsAlert("Chase engine finished with errors", [
      `Today's run: ${JSON.stringify(summary)}. Check the Vercel function logs.`,
    ]);
  }
  return NextResponse.json({ ok: true, ...summary });
}
