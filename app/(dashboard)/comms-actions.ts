"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { replyAddressFor } from "@/lib/quote/chase";
import {
  accountsFrom,
  leadOwnerIdentity,
  ownerFrom,
  ownerIdentity,
  HELLO_FROM,
} from "@/lib/comms/sender";
import { parseAltRecipient } from "@/lib/comms/alt-recipient";
import { normalizeEmail } from "@/lib/leads/phone";
import {
  dispatchComm,
  type DispatchCommInput,
  type DispatchCommResult,
} from "@/lib/comms/dispatch";

export type SendCommInput = DispatchCommInput & {
  /** Resolve a published Resend template server-side (client components can't
   *  read the env ids). When the env id is set, the template wins over bodyHtml
   *  — which stays supplied as the fallback body. */
  templateKey?: "quote-email";
  templateVariables?: Record<string, string | number>;
  /** Office-directed recipient for a quote email (the customer's address bounced
   *  or was typo'd on the lead). When set, it is validated + normalised here and
   *  becomes the send target — the server, not the client, has the last word. */
  toEmail?: string;
  /** When toEmail differs from the lead's stored email, also save it back onto
   *  the lead so every later automated email (chases, deposit/balance invoices,
   *  review request) follows the corrected address. Ignored without a leadId. */
  updateLeadEmail?: boolean;
};
export type SendCommResult = DispatchCommResult;

const TEMPLATE_KEYS: Record<NonNullable<SendCommInput["templateKey"]>, string | undefined> = {
  "quote-email": process.env.RESEND_TEMPLATE_QUOTE_EMAIL,
};

/** Dashboard send — the signed-in user's client + actor id over the shared
 *  dispatcher (duplicate guard, log, counters, activity live in dispatch.ts). */
export async function sendCommunication(input: SendCommInput): Promise<SendCommResult> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  if (input.templateKey && input.templateVariables && !input.template) {
    const id = TEMPLATE_KEYS[input.templateKey];
    if (id) input = { ...input, template: { id, variables: input.templateVariables } };
  }

  // Office-directed recipient: validate + normalise server-side, then it becomes
  // the send target (a different recipient = different content hash, so the
  // duplicate guard never mistakes it for the original send).
  let altEmail: string | null = null;
  if (input.channel === "email" && input.toEmail !== undefined) {
    const parsed = parseAltRecipient(input.toEmail);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.email) {
      altEmail = parsed.email;
      input = { ...input, to: altEmail };
    }
  }

  // Every quote/lead-linked email gets the per-lead reply address, so a
  // customer reply to ANY of our emails (quote, survey confirmation, manual
  // note) routes back into the panel — pausing chases and logging to Comms —
  // instead of dead-ending at the shared hello@ inbox.
  if (input.channel === "email" && !input.replyTo) {
    let token: string | null = null;
    if (input.quoteId) {
      const { data: q } = await sb.from("quotes").select("accept_token").eq("id", input.quoteId).maybeSingle();
      token = (q?.accept_token as string | null) ?? null;
    } else if (input.leadId) {
      const { data: q } = await sb
        .from("quotes")
        .select("accept_token")
        .eq("lead_id", input.leadId)
        .not("accept_token", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      token = (q?.accept_token as string | null) ?? null;
    }
    if (token) input = { ...input, replyTo: replyAddressFor(token) };
  }

  // A quote email sends from its ASSIGNED ESTIMATOR (Peter, 2026-07-30): Luke's
  // quote goes out as "Luke at Marley Moves <luke@marleymoves.co.uk>" so the
  // customer sees the person who priced it. When the quote is UNASSIGNED — or the
  // assignee has left / isn't on the company domain — it fronts the Accounts money
  // desk instead, NEVER whichever office admin happened to click send and never
  // the quote's creator. ownerIdentity resolves to a person only when the profile
  // is active, admin/estimator, and on marleymoves.co.uk; anything else -> accounts@.
  // Replies still route to the lead's owner via the tokenized relay set above.
  if (input.channel === "email" && input.templateKey === "quote-email" && !input.from) {
    let estimatorId: string | null = null;
    if (input.quoteId) {
      const { data: q } = await sb
        .from("quotes")
        .select("estimator_id")
        .eq("id", input.quoteId)
        .maybeSingle();
      estimatorId = (q?.estimator_id as string | null) ?? null;
    }
    const owner = await ownerIdentity(sb, estimatorId);
    // Reuse ownerFrom's OWN on-domain validation instead of a looser endsWith:
    // ownerFrom returns HELLO_FROM whenever it can't build a valid personal
    // @marleymoves.co.uk identity (unassigned, off-domain, or a malformed address
    // that would fail its header-safe regex). In that case front the Accounts
    // money desk — never hello@, never the creator.
    const fronted = ownerFrom(owner.name, owner.email);
    input = { ...input, from: fronted === HELLO_FROM ? accountsFrom() : fronted };
  }

  // Sales identity: a lead-linked email with no explicit sender goes out as
  // the lead's OWNER ("Luke at Marley Moves <luke@marleymoves.co.uk>") so the
  // customer sees the person they're dealing with, not a shared mailbox.
  // Resolution uses the CANONICAL ownership rule (leads.estimator_id, else the
  // survey-derived estimator — same as the chase cron and the inbound-reply
  // forward, so one thread is never fronted by two people); the quote's
  // creator is only a last resort. Unowned leads / off-domain logins fall back
  // to the house identity (docs/email-identity-plan.md).
  if (input.channel === "email" && !input.from) {
    let leadId: string | null = input.leadId ?? null;
    let lastResort: string | null = null;
    if (input.quoteId) {
      const { data: q } = await sb
        .from("quotes")
        .select("lead_id, estimator_id")
        .eq("id", input.quoteId)
        .maybeSingle();
      leadId = leadId ?? ((q?.lead_id as string | null) ?? null);
      lastResort = (q?.estimator_id as string | null) ?? null;
    }
    if (leadId || lastResort) {
      const owner = await leadOwnerIdentity(sb, leadId, lastResort);
      if (owner.name || owner.email) input = { ...input, from: ownerFrom(owner.name, owner.email) };
    }
  }

  const result = await dispatchComm(sb, user?.id ?? null, input);

  if ("ok" in result && result.ok) {
    // A quote email went to an office-directed address — record it against the
    // lead, and (default) adopt it as the lead's email so every later automated
    // email follows the corrected address.
    if (altEmail && input.leadId) {
      await applyAltRecipientToLead(sb, user?.id ?? null, {
        leadId: input.leadId,
        altEmail,
        save: !!input.updateLeadEmail,
      });
    }
    if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
    if (input.quoteId) revalidatePath(`/quotes/${input.quoteId}`);
  }
  return result;
}

/**
 * After a quote email went to an office-directed address, reconcile it with the
 * lead. Only acts when the address actually differs from the lead's stored one
 * (dispatchComm already logs the ordinary "email sent to X" activity + comms
 * row otherwise). Updates the LEAD's email only — never the client record, whose
 * email_norm carries a unique dedupe index a correction could collide with — and
 * drops a timeline note either way so the redirect is auditable.
 */
async function applyAltRecipientToLead(
  sb: SupabaseClient<Database>,
  actorId: string | null,
  { leadId, altEmail, save }: { leadId: string; altEmail: string; save: boolean },
): Promise<void> {
  const { data: lead } = await sb
    .from("leads")
    .select("email, client_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return;

  const differs = normalizeEmail(altEmail) !== normalizeEmail(lead.email);
  if (!differs) return; // sent to the lead's own address — nothing to reconcile

  if (save) {
    await sb.from("leads").update({ email: altEmail }).eq("id", leadId);
    await sb.from("activities").insert({
      lead_id: leadId,
      client_id: lead.client_id ?? null,
      actor_id: actorId,
      type: "note",
      summary: `Quote emailed to alternative address ${altEmail} — saved as the lead's email`,
      meta: { alt_recipient: altEmail, saved_to_lead: true, previous_email: lead.email ?? null },
    });
  } else {
    await sb.from("activities").insert({
      lead_id: leadId,
      client_id: lead.client_id ?? null,
      actor_id: actorId,
      type: "note",
      summary: `Quote emailed to alternative address ${altEmail} — one-off, lead email unchanged`,
      meta: { alt_recipient: altEmail, saved_to_lead: false },
    });
  }
}
