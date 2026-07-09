"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { replyAddressFor } from "@/lib/quote/chase";
import {
  dispatchComm,
  type DispatchCommInput,
  type DispatchCommResult,
} from "@/lib/comms/dispatch";

export type SendCommInput = DispatchCommInput;
export type SendCommResult = DispatchCommResult;

/** Dashboard send — the signed-in user's client + actor id over the shared
 *  dispatcher (duplicate guard, log, counters, activity live in dispatch.ts). */
export async function sendCommunication(input: SendCommInput): Promise<SendCommResult> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

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

  const result = await dispatchComm(sb, user?.id ?? null, input);

  if ("ok" in result && result.ok) {
    if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
    if (input.quoteId) revalidatePath(`/quotes/${input.quoteId}`);
  }
  return result;
}
