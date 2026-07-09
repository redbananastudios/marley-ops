"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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

  const result = await dispatchComm(sb, user?.id ?? null, input);

  if ("ok" in result && result.ok) {
    if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
    if (input.quoteId) revalidatePath(`/quotes/${input.quoteId}`);
  }
  return result;
}
