"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  markQuoteBalancePaidAction,
  markQuoteDepositPaidAction,
} from "@/app/(dashboard)/bookings/actions";

/**
 * Bank-feed confirmations. Confirming a suggested match runs the EXISTING
 * deposit/balance paid pipeline (Zoho payment record, chase closed, customer
 * confirmation email) — the feed never invents a new money path.
 *
 * Hardened per the 2026-07-16 review:
 *  - CLAIM-FIRST compare-and-set: the row is atomically flipped to confirmed
 *    against the exact (quote, kind) the OFFICE SAW before any money moves —
 *    if the 2-min matcher re-pointed the row (or another user got there
 *    first), the claim matches 0 rows and nothing is recorded.
 *  - `already` surfacing: if the paid pipeline reports the item was already
 *    recorded, that's a likely DUPLICATE customer payment — the row is put
 *    back as unmatched and the office told, never silently marked "Recorded".
 */

async function officeActor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin" && profile?.role !== "estimator") return null;
  return user.id;
}

export async function confirmBankTransactionAction(input: {
  txId: string;
  /** What the office's screen showed — the claim is bound to these. */
  expectedQuoteId: string;
  expectedKind: "deposit" | "balance";
}) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  if (input.expectedKind !== "deposit" && input.expectedKind !== "balance") {
    return { ok: false as const, error: "Storage payments are recorded from the Storage page." };
  }

  const admin = createAdminClient();

  // 1. Claim the row against exactly what the user saw. A re-pointed,
  //    already-confirmed or dismissed row claims 0 rows and we stop cold.
  const { data: claimed, error: claimErr } = await admin
    .from("bank_transactions")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() } as never)
    .eq("id", input.txId)
    .eq("status", "suggested")
    .eq("matched_quote_id", input.expectedQuoteId)
    .eq("match_kind", input.expectedKind)
    .select("id");
  if (claimErr) return { ok: false as const, error: claimErr.message };
  if (!claimed?.length) {
    return {
      ok: false as const,
      error: "This suggestion changed since the page loaded — refresh and check it again.",
    };
  }

  // 2. Money moves only after the claim held.
  const res =
    input.expectedKind === "deposit"
      ? await markQuoteDepositPaidAction(input.expectedQuoteId, "bank_transfer")
      : await markQuoteBalancePaidAction(input.expectedQuoteId, "bank_transfer");

  const unclaim = async (status: "suggested" | "unmatched") => {
    await admin
      .from("bank_transactions")
      .update({ status, confirmed_at: null } as never)
      .eq("id", input.txId)
      .eq("status", "confirmed");
  };

  if (!res.ok) {
    await unclaim("suggested"); // pipeline failed — put the suggestion back
    return res;
  }
  if (res.already) {
    // The quote's deposit/balance was ALREADY recorded elsewhere — this
    // transfer is probably a duplicate payment. Surface it, don't bury it.
    await unclaim("unmatched");
    return {
      ok: false as const,
      error:
        "That payment was already recorded — this transfer looks like a DUPLICATE. Check the bank and refund/credit before dismissing it.",
    };
  }

  revalidatePath("/payments");
  revalidatePath("/bookings");
  return { ok: true as const };
}

/** "Not a customer payment / already handled elsewhere" — keeps the row but
 *  takes it out of the suggestion queue for good. */
export async function dismissBankTransactionAction(txId: string) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("bank_transactions")
    .update({ status: "dismissed" } as never)
    .eq("id", txId)
    .in("status", ["suggested", "unmatched"]);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/payments");
  return { ok: true as const };
}
