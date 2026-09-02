"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  markQuoteBalancePaidAction,
  markQuoteCommitmentPaidAction,
  markQuoteDepositPaidAction,
} from "@/app/(dashboard)/bookings/actions";
import { backfillPaidMethod, claimedKindsForRow, loadLedgerItems, loadOpenItems } from "@/lib/bank-feed/sync";
import { coveringPairLinks, wholeQuoteLinks } from "@/lib/bank-feed/whole-quote";
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
/** A link that explains EVERY recorded payment on one quote (see
 *  lib/bank-feed/whole-quote.ts). Never an open-money target: there is
 *  nothing to record, only an already-recorded set to point the bank row at. */
const WHOLE_QUOTE = "full" as const;
type LinkKind = PayKind | typeof WHOLE_QUOTE;
/** One transfer covering the OPEN commitment + balance pair — the gate-9c
 *  settle-in-full shape (see coveringPairLinks). DISPLAY-ONLY target kind:
 *  confirming records the two individual payments through the normal paid
 *  pipelines, and the bank row is stamped with an EXISTING match_kind — this
 *  value is never written to the database (the 0103 CHECK constraint stands). */
const COVERING_PAIR = "pair" as const;
type TargetKind = LinkKind | typeof COVERING_PAIR;

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
  kind: TargetKind;
  /** For a whole-quote or covering-pair target, the payments it covers
   *  ("deposit", "balance") so the office sees what it is settling, not just
   *  a total. */
  kinds?: PayKind[];
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

  // A job paid off in ONE transfer matches no single settled item — its money is
  // split across deposit/balance rows. Offer the set, still only on an exact
  // penny match of the sum (QA: IMV012's real £660 vs recorded £100 + £560).
  const wholeQuote: AttachTarget[] = wholeQuoteLinks(settled, txPennies)
    .filter((w) => matchesQuery(w))
    .map((w) => ({
      quoteId: w.quoteId,
      quoteRef: w.quoteRef,
      customer: w.customer,
      kind: WHOLE_QUOTE,
      kinds: w.kinds,
      amount: w.amount,
      amountMatches: true,
      settled: true,
    }));

  // The gate-9c settle-in-full transfer: ONE payment covering the open
  // commitment + balance pair exactly (the deposit is already settled, so no
  // single item and no settled-sum can explain it). Same evidence bar as the
  // whole-quote link — exact pennies against the pair, a human picks — but the
  // confirm RECORDS both payments (they are open money, not recorded money).
  const coveringPairs: AttachTarget[] = coveringPairLinks(open, txPennies)
    .filter((p) => matchesQuery(p))
    .map((p) => ({
      quoteId: p.quoteId,
      quoteRef: p.quoteRef,
      customer: p.customer,
      kind: COVERING_PAIR,
      kinds: [...p.kinds],
      amount: p.amount,
      amountMatches: true,
      settled: false,
    }));

  const targets: AttachTarget[] = [
    ...open.filter((o) => (q ? matchesQuery(o) : pennies(o.amount) === txPennies)).map((o) => toTarget(o, false)),
    ...coveringPairs,
    // Settled items only ever link on an EXACT amount (a link binds "this
    // transfer IS that payment" with no human-readable delta to reason about).
    ...settled.filter((s) => pennies(s.amount) === txPennies && matchesQuery(s)).map((s) => toTarget(s, true)),
    ...wholeQuote,
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
  kind: LinkKind;
}) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  const wholeQuote = input.kind === WHOLE_QUOTE;
  if (!wholeQuote && !PAY_KINDS.has(input.kind)) {
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
  // The open half is loaded too: the collision check below re-derives what
  // EXISTING rows claim, and a half-recorded covering pair still has one open
  // item in its pair.
  const { open, settled } = await loadLedgerItems(admin);

  // The set this link will settle. For a whole-quote link that is every recorded
  // payment on the quote, re-derived here and re-checked against the sum — the
  // client's word for which payments it covers is never trusted.
  let items: typeof settled;
  if (wholeQuote) {
    const link = wholeQuoteLinks(settled, pennies(Number(tx.amount))).find(
      (w) => w.quoteId === input.quoteId,
    );
    if (!link) {
      return {
        ok: false as const,
        error:
          "This transfer no longer matches that quote's recorded payments exactly — refresh and check it again.",
      };
    }
    items = settled.filter((s) => s.quoteId === input.quoteId && link.kinds.includes(s.kind));
  } else {
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
    items = [item];
  }
  const item = items[0];

  // One recorded payment, one bank row. If another transfer already explains
  // this payment then THIS one is a second payment for it — linking would file
  // money we probably owe back as "explained" and it would leave every queue.
  // A whole-quote link claims EVERY payment on the quote, so any existing match
  // on that quote collides with it; a single-kind link collides with its own
  // kind.
  //
  // What an existing row claims is DERIVED, never read off its stamp: a 'full'
  // row covers all three kinds and a covering-pair row covers two while
  // stamping one, so comparing `match_kind` directly was blind to a
  // 'balance'-stamped pair row when linking that quote's commitment — exactly
  // the payment the pair already recorded.
  // (`input.kind` is a PayKind on this branch — the guard above returned for
  // anything that is neither WHOLE_QUOTE nor a pay kind.)
  const wanted: PayKind[] = wholeQuote ? ["deposit", "commitment", "balance"] : [input.kind as PayKind];
  const { data: rowsOnQuote, error: alreadyErr } = await admin
    .from("bank_transactions")
    .select("id, match_kind, amount")
    .eq("matched_quote_id", input.quoteId)
    .in("status", ["confirmed", "reconciled"])
    .neq("id", input.txId);
  if (alreadyErr) return { ok: false as const, error: alreadyErr.message };
  const ledgerItems = [...open, ...settled];
  const already = (rowsOnQuote ?? []).filter((r) =>
    claimedKindsForRow(
      {
        quoteId: input.quoteId,
        kind: (r.match_kind as string | null) ?? null,
        amount: Number(r.amount),
      },
      ledgerItems,
    ).some((k) => wanted.includes(k)),
  );
  if (already.length) {
    const what = wholeQuote ? "this job" : `${item.quoteRef}'s ${input.kind}`;
    return {
      ok: false as const,
      error: `Another transfer is already matched to ${what}, so this looks like a SECOND payment for it. Check the bank and refund or credit the customer before clearing this row.`,
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
  if (claimErr) {
    // Whole-job links need migration 0103 (the match_kind CHECK must accept
    // 'full'). Deploys and migrations are separate steps here, so the code can
    // legitimately reach an environment the migration has not, and a raw
    // Postgres constraint string on a money screen tells the office nothing.
    // Fails closed with something actionable instead; nothing is written.
    if (wholeQuote && claimErr.code === "23514") {
      return {
        ok: false as const,
        error:
          "This database hasn't been migrated for whole-job links yet (0103). Nothing was changed — link the deposit and balance separately, or ask for the migration to be applied.",
      };
    }
    return { ok: false as const, error: claimErr.message };
  }
  if (!claimed?.length) {
    return { ok: false as const, error: "This transfer changed since the page loaded — refresh and check it again." };
  }

  // The link proves the payment arrived by bank — fill a missing method so the
  // received ledger stops saying "Method not recorded". Fill-only, best-effort.
  for (const covered of items) await backfillPaidMethod(admin, covered);

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

/**
 * Office confirms a settle-in-full covering transfer: ONE payment equal, to
 * the penny, to the sum of a quote's open commitment + open balance (the gate-
 * 9c shape — the deposit is already recorded, so no single open item, no
 * settled item and no whole-quote settled-sum can explain the transfer, and it
 * previously sat as a permanent mismatch while the customer was chased for the
 * commitment they had paid).
 *
 * Same evidence bar as every other bank-feed money action: exact pennies,
 * re-derived server-side at confirm time, and a HUMAN tap — this is never
 * suggested by the sync and never auto-recorded. Confirming records the two
 * individual payments through the existing paid pipelines (commitment first,
 * ledger order). No new match_kind: the row is claimed as 'commitment' while
 * that half records, then re-stamped 'balance' once both are recorded (the
 * ledger date follows the larger payment). The stamp is an under-claim of what
 * the transfer paid — one column cannot say "two payments" — so what the row
 * CLAIMS is re-derived from the ledger by `coveringPairPartner`, at both the
 * automatic gate (the sync's `claimed` set) and the manual one (the link
 * collision check). Without that, the unstamped half was recorded money no
 * bank row claimed, and a second transfer for it auto-reconciled as explained.
 *
 * Partial failure is LOUD: if the commitment half fails nothing was recorded
 * and the row is put back exactly as it was; if the balance half fails after
 * the commitment recorded, the row is put back stamped with the commitment it
 * did buy (so that claim survives), the office is told exactly what state the
 * quote is in, and an ops alert is raised — a half-recorded transfer must never
 * silently read as "Recorded".
 */
export async function recordCoveringPairAction(input: { txId: string; quoteId: string }) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };

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

  // Fresh pair check — the exact-sum invariant, server-side, never trusted
  // from the client. coveringPairLinks refuses ambiguity (anything other than
  // exactly one open commitment + one open balance on the quote) by design.
  const open = await loadOpenItems(admin);
  const pair = coveringPairLinks(open, pennies(Number(tx.amount))).find((p) => p.quoteId === input.quoteId);
  if (!pair) {
    return {
      ok: false as const,
      error:
        "This transfer no longer covers that quote's open commitment + balance exactly (paid, cancelled or changed) — refresh and check it again.",
    };
  }

  // Claim-first CAS against the status the office saw; a concurrent
  // confirm/dismiss/re-match wins and nothing is recorded. Claimed as
  // 'commitment' — the half that records first — so at every moment the row
  // only ever claims a payment this transfer has actually bought.
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
      match_kind: "commitment",
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

  const revert = async (status: string, context: string) => {
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
    if (error) await alertStuckRow(input.txId, context, error.message);
  };

  // 1. Commitment half. A failure here recorded nothing — put the row back.
  const com = await runPaidPipeline("commitment", input.quoteId);
  if (!com.ok) {
    await revert(prior.status, "a covering-pair confirm (commitment half)");
    return com;
  }
  if (com.already) {
    await revert("unmatched", "a covering-pair confirm (commitment half)");
    return {
      ok: false as const,
      error:
        "That commitment was already recorded — this transfer looks like it includes a DUPLICATE. Check the bank and refund/credit before dismissing it.",
    };
  }

  // 2. Balance half. The commitment IS now recorded, so from here the row must
  //    never silently read "Recorded" for money that only half-landed: put the
  //    row back in the queue (the unexplained portion stays visible), tell the
  //    office exactly what happened, and page ops.
  const bal = await runPaidPipeline("balance", input.quoteId);
  if (!bal.ok || bal.already) {
    // Back in the queue, but NOT back to its prior stamp: the commitment is
    // recorded and this transfer is what paid it, so `revert` would leave
    // recorded money claimed by nothing and the customer's next standing-order
    // £400 would auto-reconcile as "explained" with no human in the loop.
    // Stamped 'commitment' at the pair-sum amount is the shape buildClaimedKeys
    // reads as "this queued row already bought the recorded commitment".
    const { error: parkErr } = await admin
      .from("bank_transactions")
      .update({
        status: "unmatched",
        matched_quote_id: input.quoteId,
        match_kind: "commitment",
        match_confidence: null,
        confirmed_at: null,
      } as never)
      .eq("id", input.txId)
      .eq("status", "confirmed");
    if (parkErr) await alertStuckRow(input.txId, "a covering-pair confirm (balance half)", parkErr.message);
    const detail = bal.ok
      ? "the balance was ALREADY recorded elsewhere, so the balance portion of this transfer may be a duplicate — check the bank before clearing the row"
      : `recording the balance FAILED: ${bal.error}. Record the balance manually via Bookings/Zoho, then dismiss the row`;
    log.error("bank-feed.covering-pair.balance_half_failed", {
      txId: input.txId,
      quoteId: input.quoteId,
      quoteRef: pair.quoteRef,
      already: bal.ok ? bal.already === true : false,
    });
    await sendOpsAlert(`Settle-in-full transfer only half recorded — ${pair.quoteRef} needs a manual fix`, [
      `A £${Number(tx.amount).toFixed(2)} transfer was confirmed as ${pair.quoteRef}'s commitment + balance. The commitment (£${pair.commitmentAmount.toFixed(2)}) was recorded, but ${detail}.`,
      `The bank row is back in the queue on /payments so the unexplained portion stays visible.`,
    ], "system");
    return {
      ok: false as const,
      error: `The commitment (£${pair.commitmentAmount.toFixed(2)}) was recorded, but ${detail}.`,
    };
  }

  // Both recorded. Re-stamp the row as the balance — the larger payment — so
  // the received ledger dates it to the day it really arrived. Best-effort, and
  // safe either way now: `coveringPairPartner` recovers the pair from EITHER
  // stamp, so a failed re-stamp costs the ledger date, not the claim.
  const { error: stampErr } = await admin
    .from("bank_transactions")
    .update({ match_kind: "balance" } as never)
    .eq("id", input.txId)
    .eq("status", "confirmed")
    .eq("matched_quote_id", input.quoteId);
  if (stampErr) {
    log.error("bank-feed.covering-pair.restamp_failed", { txId: input.txId, error: stampErr.message });
  }

  revalidatePath("/payments");
  revalidatePath("/bookings");
  return { ok: true as const, quoteRef: pair.quoteRef };
}

/**
 * Undo a LINK (status 'reconciled') — the row goes back to 'unmatched' for the
 * matcher and the office to look at again. Reconciled rows are otherwise
 * locked: the sync never rewrites them and no other action accepts them, so a
 * mis-tapped link (or a wrong auto-reconcile) was database surgery to undo.
 * Only ever touches the LINK, never the payment: nothing was recorded by
 * reconciling, so nothing needs unrecording.
 */
export async function unlinkBankTransactionAction(txId: string) {
  const userId = await officeActor();
  if (!userId) return { ok: false as const, error: "Office access required." };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("bank_transactions")
    .update({
      status: "unmatched",
      matched_quote_id: null,
      match_kind: null,
      match_confidence: null,
    } as never)
    .eq("id", txId)
    .eq("status", "reconciled")
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!data?.length) {
    return { ok: false as const, error: "This transfer is no longer linked — refresh and check it again." };
  }
  revalidatePath("/payments");
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
