import { createClient } from "@supabase/supabase-js";

/**
 * A service-role handle on the TARGET database, for the one thing a browser
 * cannot do: make something happen to a record WHILE a dialog sits open on it.
 *
 * Specs arrange state through the seed and assert it through the UI wherever
 * they can. Two things do not fit that: a concurrency guard, and TEARING DOWN
 * state a spec created through the UI so the next spec still meets its
 * documented preconditions (see deleteCrewStatements below).
 *
 * A concurrency guard cannot be tested through the seed — the whole point is a
 * change that lands between the dialog reading the world and the operator acting
 * on it, and the second actor is a customer's payment, not another screen. Two
 * of the three payment rails have no "mark it paid" control anywhere in the app
 * (the 25% commitment is only ever recorded by the bank-feed match), so there is
 * no UI path that could arrange all three rails alike.
 *
 * What lands here is exactly what the real paid pipelines compare-and-set, so
 * the guard sees the state a real payment produces:
 *   deposit    → quotes.deposit_paid_at + method, AND leads.deposit_paid_at
 *                (markDepositPaid writes both; canResendInvoiceNow reads both)
 *   commitment → quotes.commitment_paid_at + method  (markCommitmentPaid)
 *   balance    → leads.balance_paid_at + method      (markBalancePaid)
 * Nothing else is touched: no Zoho, no email, no chase, no diary. A race test
 * must never be able to write to a customer.
 *
 * SAFETY: the same hard prod refusal the seed script carries. globalSetup blocks
 * a prod APP host; this blocks a prod DATABASE host, so neither half of a
 * misconfigured run can reach production.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** The CI e2e job already exports both (it seeds staging with them). */
export const E2E_DB_READY = !!url && !!serviceKey;

export type PayRail = "deposit" | "commitment" | "balance";

function db() {
  if (!E2E_DB_READY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required to drive a payment race.",
    );
  }
  if (url.includes("supabase.redbananastudios.com")) {
    throw new Error(`E2E refuses to touch the PRODUCTION Supabase host (${url}).`);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/** A service-role handle for a spec's OWN ad-hoc seed/teardown (marker rows it
 *  creates and deletes itself), carrying the same prod-host refusal as every
 *  other use of this file. Prefer the named helpers above where one exists. */
export function adminClient() {
  return db();
}

export interface SeededJob {
  leadId: string;
  quoteId: string;
  quoteRef: string;
}

/** Resolve a seeded job by its quote ref — the spec's unique handle on one row. */
export async function jobByQuoteRef(quoteRef: string): Promise<SeededJob> {
  const { data, error } = await db()
    .from("quotes")
    .select("id, lead_id")
    .eq("quote_ref", quoteRef)
    .maybeSingle();
  if (error) throw new Error(`Looking up ${quoteRef} failed: ${error.message}`);
  if (!data?.lead_id) throw new Error(`No seeded quote ${quoteRef} — re-run scripts/seed-e2e.mjs.`);
  return { leadId: data.lead_id, quoteId: data.id, quoteRef };
}

/** The paid stamps the re-send guard reads, straight from the database. */
export async function paidStamps(
  job: SeededJob,
  rail: PayRail,
): Promise<{ quote: string | null; lead: string | null }> {
  const sb = db();
  const [{ data: q, error: qErr }, { data: l, error: lErr }] = await Promise.all([
    sb.from("quotes").select("deposit_paid_at, commitment_paid_at").eq("id", job.quoteId).single(),
    sb.from("leads").select("deposit_paid_at, balance_paid_at").eq("id", job.leadId).single(),
  ]);
  if (qErr) throw new Error(`Reading ${job.quoteRef} failed: ${qErr.message}`);
  if (lErr) throw new Error(`Reading the lead for ${job.quoteRef} failed: ${lErr.message}`);
  if (rail === "deposit") return { quote: q.deposit_paid_at, lead: l.deposit_paid_at };
  if (rail === "commitment") return { quote: q.commitment_paid_at, lead: null };
  return { quote: null, lead: l.balance_paid_at };
}

/**
 * The customer's money lands. Writes the same columns the real paid pipeline
 * compare-and-sets — and asserts the write took, because a silently-failed
 * arrange step would leave the guard with nothing to refuse and the test would
 * pass having proved nothing.
 */
export async function landPayment(job: SeededJob, rail: PayRail): Promise<void> {
  const sb = db();
  const now = new Date().toISOString();
  if (rail === "deposit") {
    const { error: qErr } = await sb
      .from("quotes")
      .update({ deposit_paid_at: now, deposit_paid_method: "bank_transfer" })
      .eq("id", job.quoteId);
    if (qErr) throw new Error(`Landing the deposit on ${job.quoteRef} failed: ${qErr.message}`);
    const { error: lErr } = await sb
      .from("leads")
      .update({ deposit_paid_at: now })
      .eq("id", job.leadId);
    if (lErr) throw new Error(`Landing the deposit on the lead failed: ${lErr.message}`);
  } else if (rail === "commitment") {
    const { error } = await sb
      .from("quotes")
      .update({ commitment_paid_at: now, commitment_paid_method: "bank_transfer" })
      .eq("id", job.quoteId);
    if (error) throw new Error(`Landing the commitment on ${job.quoteRef} failed: ${error.message}`);
  } else {
    const { error } = await sb
      .from("leads")
      .update({ balance_paid_at: now, balance_paid_method: "bank_transfer" })
      .eq("id", job.leadId);
    if (error) throw new Error(`Landing the balance on ${job.quoteRef} failed: ${error.message}`);
  }
  const after = await paidStamps(job, rail);
  if (!after.quote && !after.lead) {
    throw new Error(`The ${rail} payment did not stamp ${job.quoteRef} — the race was never set up.`);
  }
}

/**
 * Put the seeded job back exactly as the seed left it, so the spec is re-runnable
 * without a reseed and leaves no consumed state behind for the next spec.
 */
export async function clearPayment(job: SeededJob, rail: PayRail): Promise<void> {
  const sb = db();
  if (rail === "deposit") {
    await sb
      .from("quotes")
      .update({ deposit_paid_at: null, deposit_paid_method: null })
      .eq("id", job.quoteId);
    await sb.from("leads").update({ deposit_paid_at: null }).eq("id", job.leadId);
  } else if (rail === "commitment") {
    await sb
      .from("quotes")
      .update({ commitment_paid_at: null, commitment_paid_method: null })
      .eq("id", job.quoteId);
  } else {
    await sb
      .from("leads")
      .update({ balance_paid_at: null, balance_paid_method: null })
      .eq("id", job.leadId);
  }
}

/**
 * Delete a crew member's statements (and their lines).
 *
 * The seed wipes these once per CI invocation, which is what
 * `invoicing-submit-lines.spec.ts` documents relying on — "a fresh suite
 * invocation always starts unsigned/statement-free". That precondition holds
 * against the seed but NOT against a sibling spec: once
 * `hours-to-admin-statements.spec.ts` (alphabetically first) creates and
 * SUBMITS this week's invoice, "This week" no longer opens an editable draft
 * and the sibling fails. A spec that submits an invoice has to put it back.
 */
export async function deleteCrewStatements(fullName: string): Promise<void> {
  const sb = db();
  const { data: staff, error: staffErr } = await sb.from("staff").select("id").eq("full_name", fullName);
  if (staffErr) throw new Error(`Looking up staff ${fullName} failed: ${staffErr.message}`);
  const staffIds = (staff ?? []).map((s) => s.id);
  if (!staffIds.length) return;

  const { data: stmts, error: stmtErr } = await sb.from("staff_statements").select("id").in("staff_id", staffIds);
  if (stmtErr) throw new Error(`Reading statements for ${fullName} failed: ${stmtErr.message}`);
  const ids = (stmts ?? []).map((s) => s.id);
  if (!ids.length) return;

  // Lines first — they reference the statement.
  const { error: lineErr } = await sb.from("staff_statement_lines").delete().in("statement_id", ids);
  if (lineErr) throw new Error(`Clearing statement lines for ${fullName} failed: ${lineErr.message}`);
  const { error: delErr } = await sb.from("staff_statements").delete().in("id", ids);
  if (delErr) throw new Error(`Clearing statements for ${fullName} failed: ${delErr.message}`);
}
