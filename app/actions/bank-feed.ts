"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  markQuoteBalancePaidAction,
  markQuoteCommitmentPaidAction,
  markQuoteDepositPaidAction,
} from "@/app/(dashboard)/bookings/actions";
import { backfillPaidMethod, loadLedgerItems, loadOpenItems } from "@/lib/bank-feed/sync";
import type { OpenItem } from "@/lib/bank-feed/match";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { log } from "@/lib/log";

/**
 * Bank-feed confirmations. Confirming a suggested match runs the EXISTING
 * deposit/commitment/balance paid pipeline (Zoho payment record, chase closed,
 * customer confirmation email) — the feed never invents a new money path.
 *
 * Hardened per the 2026-07-16 review:
 *  - CLAIM-FIRST compare-and-set: the row is atomically flipped to confirmed
 *    against the exact (quote, kind) the OFFICE SAW before any money moves —
 *    if the 2-min matcher re-pointed the row (or another user got there
 *    first), the claim matches 0 rows and nothing is recorded.
 *  - `already` surfacing: if the paid pipeline reports the item was already
 *    recorded, that's a likely DUPLICATE customer payment — the row is put
 *    back as unmatched and the office told, never silently marked "Recorded".
 *
 * The manual ATTACH flow (unmatched/mismatch rows) follows the same shape but
 * the office — not the matcher — names the (quote, kind). The server still
 * refuses unless that open item's amount equals the transfer to the penny:
 * part-payments and overpayments stay human territory (the paid pipeline
 * records the ITEM's amount, so attaching a £50 transfer to a £500 balance
 * would book £500 off £50 received).
 */

type PayKind = "deposit" | "commitment" | "balance";
const PAY_KINDS = new Set<string>(["deposit", "commitment", "balance"]);

const pennies = (n: number): number => Math.round(n * 100);

async function officeActor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  // Mirror the DB-side is_office(): role AND active. Deactivation is the
  // fired-employee control and sessions outlive it — a deactivated admin
  // must fail closed here, not just at RLS.
  const { data: profile } = await sb.from("profiles").select("role, active").eq("id", user.id).single();
  if ((profile?.role !== "admin" && profile?.role !== "estimator") || profile?.active === false) return null;
  return user.id;
}

/** A claimed row we couldn't put back — the durable surface now lies
 *  ("Recorded" with nothing recorded). Page a human; never fail silently. */
async function alertStuckRow(txId: string, context: string, dbError: string) {
  log.error("bank-feed.revert.failed", { txId, context, error: dbError });
  await sendOpsAlert(`Bank-feed row stuck as Recorded — needs a manual fix`, [
    `A bank transfer row (id ${txId}) was claimed for ${context}, the paid pipeline did not complete, and putting the row back FAILED: ${dbError}.`,
    `The row now shows "Recorded" on /payments but no payment was recorded. Reset its status in the database or retry the payment, then verify against the bank statement.`,
  ], "system");
}

async function runPaidPipeline(kind: PayKind, quoteId: string) {
  if (kind === "deposit") return markQuoteDepositPaidAction(quoteId, "bank_transfer");
  if (kind === "commitment") return markQuoteCommitmentPaidAction(quoteId, "bank_transfer");
  return markQuoteBalancePaidAction(quoteId, "bank_transfer");
}

export async function confirmBankTransactionAction(input: {
  txId: string;
  /** What the office's screen showed — the claim is bound to these. */
  expectedQuoteId: string;
  expectedKind: PayKind;
}) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  if (!PAY_KINDS.has(input.expectedKind)) {
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
    .select("id, amount");
  if (claimErr) return { ok: false as const, error: claimErr.message };
  if (!claimed?.length) {
    return {
      ok: false as const,
      error: "This suggestion changed since the page loaded — refresh and check it again.",
    };
  }

  const unclaim = async (status: "suggested" | "unmatched") => {
    const { error } = await admin
      .from("bank_transactions")
      .update({ status, confirmed_at: null } as never)
      .eq("id", input.txId)
      .eq("status", "confirmed");
    if (error) await alertStuckRow(input.txId, "a bank-feed confirm", error.message);
  };

  // 2. The suggestion was computed by an earlier sync pass — re-verify the
  //    open item NOW, after the claim (so the sync can't rewrite underneath):
  //    a cancelled booking or an item paid elsewhere must not take money, and
  //    the row's amount must still equal the item's to the penny.
  const open = await loadOpenItems(admin);
  const item = open.find((o) => o.quoteId === input.expectedQuoteId && o.kind === input.expectedKind);
  if (!item || pennies(item.amount) !== pennies(Number(claimed[0].amount))) {
    await unclaim("unmatched");
    return {
      ok: false as const,
      error: "This payment is no longer open on that quote (paid, cancelled or changed) — refresh and check it again.",
    };
  }

  // 3. Money moves only after the claim held and the item re-verified.
  const res = await runPaidPipeline(input.expectedKind, input.expectedQuoteId);

  if (!res.ok) {
    await unclaim("suggested"); // pipeline failed — put the suggestion back
    return res;
  }
  if (res.already) {
    // The quote's item was ALREADY recorded elsewhere — this transfer is
    // probably a duplicate payment. Surface it, don't bury it.
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

export interface AttachTarget {
  quoteId: string;
  quoteRef: string;
  customer: string | null;
  kind: PayKind;
  amount: number;
  /** Equals the transfer to the penny — only these are attachable. */
  amountMatches: boolean;
  /** Payment already recorded on the books — attaching LINKS the transfer
   *  (status reconciled, arrival-day truth for /payments) and never re-runs
   *  the paid pipeline. */
  settled: boolean;
}

/** Open items the office can attach a transfer to, plus SETTLED items it can
 *  link as "already recorded" (a transfer whose payment was recorded via
 *  Zoho/manual before the bank row processed — Dingley's £1,100). Empty query
 *  → everything whose amount matches the transfer (the "what could this £50
 *  be?" view); a query filters ALL items by ref/customer so a near-miss still
 *  shows up, marked un-attachable with the amount it actually wants. */
export async function searchAttachTargetsAction(input: { txId: string; query: string }) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };

  const admin = createAdminClient();
  const { data: tx, error: txErr } = await admin
    .from("bank_transactions")
    .select("id, amount, status")
    .eq("id", input.txId)
    .maybeSingle();
  if (txErr) return { ok: false as const, error: txErr.message };
  if (!tx) return { ok: false as const, error: "Transfer not found." };

  const { open, settled } = await loadLedgerItems(admin);
  const q = input.query.trim().toUpperCase();
  const matchesQuery = (o: Pick<OpenItem, "quoteRef" | "customer">) =>
    !q || o.quoteRef.toUpperCase().includes(q) || (o.customer ?? "").toUpperCase().includes(q);
  const txPennies = pennies(Number(tx.amount));

  const toTarget = (o: OpenItem, isSettled: boolean): AttachTarget => ({
    quoteId: o.quoteId,
    quoteRef: o.quoteRef,
    customer: o.customer,
    kind: o.kind,
    amount: o.amount,
    amountMatches: pennies(o.amount) === txPennies,
    settled: isSettled,
  });

  const targets: AttachTarget[] = [
    ...open.filter((o) => (q ? matchesQuery(o) : pennies(o.amount) === txPennies)).map((o) => toTarget(o, false)),
    // Settled items only ever link on an EXACT amount (a link binds "this
    // transfer IS that payment" with no human-readable delta to reason about).
    ...settled.filter((s) => pennies(s.amount) === txPennies && matchesQuery(s)).map((s) => toTarget(s, true)),
  ]
    .sort((a, b) => {
      if (a.settled !== b.settled) return a.settled ? 1 : -1; // open money first
      if (a.amountMatches !== b.amountMatches) return a.amountMatches ? -1 : 1;
      return a.quoteRef.localeCompare(b.quoteRef);
    })
    .slice(0, 15);

  return { ok: true as const, targets };
}

/** Office links a transfer to a payment that is ALREADY recorded (Zoho/manual
 *  path beat the bank row). Sets status 'reconciled' — the paid pipeline must
 *  NOT run again; the link gives /payments the arrival-day truth and takes the
 *  row out of "Unmatched inbound" without losing what it was. */
export async function linkRecordedBankTransactionAction(input: {
  txId: string;
  quoteId: string;
  kind: PayKind;
}) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  if (!PAY_KINDS.has(input.kind)) {
    return { ok: false as const, error: "Storage payments are recorded from the Storage page." };
  }

  const admin = createAdminClient();
  const { data: tx, error: txErr } = await admin
    .from("bank_transactions")
    .select("id, amount, status")
    .eq("id", input.txId)
    .maybeSingle();
  if (txErr) return { ok: false as const, error: txErr.message };
  if (!tx || (tx.status !== "unmatched" && tx.status !== "suggested")) {
    return { ok: false as const, error: "This transfer changed since the page loaded — refresh and check it again." };
  }

  // Server-side re-verify: the named payment must be SETTLED at exactly this
  // amount. (An open item here means the office picked the wrong row — the
  // attach path records open money, this one only explains recorded money.)
  const { settled } = await loadLedgerItems(admin);
  const item = settled.find((s) => s.quoteId === input.quoteId && s.kind === input.kind);
  if (!item) {
    return { ok: false as const, error: "That payment isn't recorded on that quote — use Attach to record open money." };
  }
  if (pennies(item.amount) !== pennies(Number(tx.amount))) {
    return {
      ok: false as const,
      error: `Amount differs — the recorded ${input.kind} on ${item.quoteRef} is £${item.amount.toFixed(2)}. If this transfer is part of it, clear it instead.`,
    };
  }

  const { data: claimed, error: claimErr } = await admin
    .from("bank_transactions")
    .update({
      status: "reconciled",
      matched_quote_id: input.quoteId,
      match_kind: input.kind,
      match_confidence: "manual",
    } as never)
    .eq("id", input.txId)
    .eq("status", tx.status)
    .eq("amount", tx.amount)
    .select("id");
  if (claimErr) return { ok: false as const, error: claimErr.message };
  if (!claimed?.length) {
    return { ok: false as const, error: "This transfer changed since the page loaded — refresh and check it again." };
  }

  // The link proves the payment arrived by bank — fill a missing method so the
  // received ledger stops saying "Method not recorded". Fill-only, best-effort.
  await backfillPaidMethod(admin, item);

  revalidatePath("/payments");
  return { ok: true as const, quoteRef: item.quoteRef };
}

/** Office names the (quote, kind) for a transfer the matcher couldn't place.
 *  Same claim-first CAS + paid pipeline as Confirm; the open item is
 *  re-verified server-side at attach time, never trusted from the client. */
export async function attachBankTransactionAction(input: {
  txId: string;
  quoteId: string;
  kind: PayKind;
}) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  if (!PAY_KINDS.has(input.kind)) {
    return { ok: false as const, error: "Storage payments are recorded from the Storage page." };
  }

  const admin = createAdminClient();
  const { data: tx, error: txErr } = await admin
    .from("bank_transactions")
    .select("id, amount, status, matched_quote_id, match_kind, match_confidence")
    .eq("id", input.txId)
    .maybeSingle();
  if (txErr) return { ok: false as const, error: txErr.message };
  if (!tx || (tx.status !== "unmatched" && tx.status !== "suggested")) {
    return { ok: false as const, error: "This transfer changed since the page loaded — refresh and check it again." };
  }

  // Fresh open-item check — the exact-amount invariant, server-side.
  const open = await loadOpenItems(admin);
  const item = open.find((o) => o.quoteId === input.quoteId && o.kind === input.kind);
  if (!item) {
    return { ok: false as const, error: "That quote no longer has this payment open — refresh and check it again." };
  }
  if (pennies(item.amount) !== pennies(Number(tx.amount))) {
    return {
      ok: false as const,
      error: `Amount differs — the open ${input.kind} on ${item.quoteRef} is £${item.amount.toFixed(2)}. Part-payments must be recorded manually via Bookings/Zoho.`,
    };
  }

  // Claim-first CAS against the status the office saw; a concurrent
  // confirm/dismiss/re-match wins and nothing is recorded.
  const prior = {
    status: tx.status,
    matched_quote_id: (tx.matched_quote_id as string | null) ?? null,
    match_kind: (tx.match_kind as string | null) ?? null,
    match_confidence: (tx.match_confidence as string | null) ?? null,
  };
  const { data: claimed, error: claimErr } = await admin
    .from("bank_transactions")
    .update({
      status: "confirmed",
      matched_quote_id: input.quoteId,
      match_kind: input.kind,
      match_confidence: "manual",
      confirmed_at: new Date().toISOString(),
    } as never)
    .eq("id", input.txId)
    .eq("status", prior.status)
    // Bind the amount too: the 2-min sync's sheet upsert may rewrite a
    // mutable-window row between our read and this claim.
    .eq("amount", tx.amount)
    .select("id");
  if (claimErr) return { ok: false as const, error: claimErr.message };
  if (!claimed?.length) {
    return { ok: false as const, error: "This transfer changed since the page loaded — refresh and check it again." };
  }

  const res = await runPaidPipeline(input.kind, input.quoteId);

  const revert = async (status: string) => {
    const { error } = await admin
      .from("bank_transactions")
      .update({
        status,
        matched_quote_id: prior.matched_quote_id,
        match_kind: prior.match_kind,
        match_confidence: prior.match_confidence,
        confirmed_at: null,
      } as never)
      .eq("id", input.txId)
      .eq("status", "confirmed");
    if (error) await alertStuckRow(input.txId, "a manual attach", error.message);
  };

  if (!res.ok) {
    await revert(prior.status); // pipeline failed — put the row back as it was
    return res;
  }
  if (res.already) {
    await revert("unmatched");
    return {
      ok: false as const,
      error:
        "That payment was already recorded — this transfer looks like a DUPLICATE. Check the bank and refund/credit before dismissing it.",
    };
  }

  revalidatePath("/payments");
  revalidatePath("/bookings");
  return { ok: true as const, quoteRef: item.quoteRef };
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
