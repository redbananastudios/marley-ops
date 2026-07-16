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
 * confirmation email) — the feed never invents a new money path. Office-gated;
 * bank_transactions writes go through the admin client (RLS is read-only).
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

export async function confirmBankTransactionAction(txId: string) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };

  const admin = createAdminClient();
  const { data: tx } = await admin
    .from("bank_transactions")
    .select("id, status, match_kind, matched_quote_id, amount")
    .eq("id", txId)
    .maybeSingle();
  if (!tx) return { ok: false as const, error: "Transaction not found." };
  if (tx.status === "confirmed") return { ok: true as const, already: true as const };
  if (tx.status !== "suggested" || !tx.matched_quote_id || !tx.match_kind) {
    return { ok: false as const, error: "No confirmed match on this transaction." };
  }
  if (tx.match_kind === "storage") {
    return { ok: false as const, error: "Storage payments are recorded from the Storage page." };
  }

  const res =
    tx.match_kind === "deposit"
      ? await markQuoteDepositPaidAction(tx.matched_quote_id, "bank_transfer")
      : await markQuoteBalancePaidAction(tx.matched_quote_id, "bank_transfer");
  if (!res.ok) return res;

  const { error } = await admin
    .from("bank_transactions")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() } as never)
    .eq("id", txId)
    .eq("status", "suggested");
  if (error) return { ok: false as const, error: error.message };

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
