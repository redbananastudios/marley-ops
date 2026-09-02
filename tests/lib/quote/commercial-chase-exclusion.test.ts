import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balanceInvoiceDue } from "@/lib/payments/balance-invoice-due";
import { chaseableQuotes } from "@/lib/quote/chase";

/**
 * "Commercial is excluded from the chase engine entirely" (PRD §3.10), and
 * since 2026-08-28 its invoices are raised BY HAND on completion — so nothing
 * automatic may email a commercial customer about money, and nothing automatic
 * may raise its invoice.
 *
 * The chase cron has FIVE stages that reach a customer or an alarm, each with
 * its own quotes query. An exclusion added to one and missed in another is
 * silent, which is why this is a source guard and not four behaviour tests: it
 * fails when a SIXTH stage arrives without one.
 */

const CRON = readFileSync(join(process.cwd(), "app/api/cron/chase/route.ts"), "utf8");

/** The cron with `//` comment lines stripped. A guard must assert on CODE:
 *  the first version of the .neq assertion below matched the comment that
 *  explains why not to use .neq, and failed on a correct file. */
const CODE = CRON.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

describe("every chase stage excludes commercial", () => {
  it("the shared quote array is filtered once, covering quote + deposit chases", () => {
    // Both stages read allQuotes via pickQuote, so one filter is the whole
    // exclusion for two of the five. It must be the policy-aware helper, not a
    // bare snapshot read: payment_policy is snapshotted AT ACCEPTANCE, so it is
    // NULL on every sent quote — and the quote chase is the one stage operating
    // exclusively on unaccepted quotes. A snapshot-only filter excluded
    // commercial from every stage EXCEPT the only one that could reach an
    // unaccepted commercial client (day-2 "accept it online", day-5 "pay the
    // £100 deposit" — to a client on account terms whose /q page has no accept
    // action and says "Nothing to pay now").
    expect(CRON).toContain("chaseableQuotes(");
  });

  it("the cron resolves the live client policy for pre-acceptance quotes", () => {
    // The same lookup /q's review gate uses (clients.is_company via
    // resolvePaymentPolicy) — and a failed clients read must THROW like the
    // other two driving queries, never silently classify every commercial
    // client as residential and email them.
    expect(CODE).toMatch(/from\("clients"\)/);
    expect(CODE).toMatch(/select\("id, is_company"\)/);
    expect(CODE).toMatch(/clients query failed/);
  });

  it("filters in CODE, never as a .neq on the query", () => {
    // In Postgres a NOT-EQUAL also drops NULLs, and payment_policy is NULL on
    // every UNACCEPTED quote — exactly the population the quote chase exists to
    // chase. `.neq("payment_policy","commercial")` would have silently stopped
    // chasing every unaccepted residential quote, which is a revenue bug that
    // looks like nothing at all.
    expect(CODE).not.toMatch(/neq\(\s*"payment_policy"/);
  });

  it("the post-move sweep and the commitment ladder each skip commercial", () => {
    const skips = CRON.split('policyOfQuote(q) === "commercial") continue;').length - 1;
    expect(
      skips,
      "post-move sweep and commitment ladder must each carry their own skip",
    ).toBe(2);
  });

  it("every quotes query in the cron selects payment_policy", () => {
    // A stage that filters on a column it did not select compares against
    // undefined — false on every row, silently, which is the failure this whole
    // file exists to prevent.
    const selects = CRON.match(/"id, [^"]*"/g) ?? [];
    const quoteSelects = selects.filter((sel) => sel.includes("quote_ref"));
    expect(quoteSelects.length, "expected the cron's quote selects").toBeGreaterThanOrEqual(3);
    for (const sel of quoteSelects) {
      expect(sel, `this quotes select omits payment_policy: ${sel.slice(0, 70)}...`).toContain(
        "payment_policy",
      );
    }
  });
});

describe("the T-7 balance raise refuses commercial", () => {
  // A residential booking that IS due, so the commercial case differs by one
  // field and nothing else.
  const TODAY = "2026-09-01";
  const T7 = "2026-09-08";
  const quote = {
    source: null,
    standard_comms_at: null,
    payment_policy: null as string | null,
    status: "accepted",
    moving_date: "2026-09-05",
    zoho_balance_invoice_id: null,
    booking_cancelled_at: null,
  };
  const lead = {
    status: "confirmed",
    balance_paid_at: null,
    date_confirmed_at: "2026-08-20T10:00:00Z",
  };

  it("a residential quote inside T-7 is still due", () => {
    // The control. This rule's existing behaviour must not move.
    expect(balanceInvoiceDue(quote, lead, TODAY, T7)).toBe(true);
  });

  it("a commercial quote is never queued, however close the move", () => {
    // Commercial invoices are raised by hand on completion. Automating one at
    // T-7 would create AND EMAIL a full-price invoice a week before the move,
    // on a booking the office is going to invoice itself - two invoices for one
    // job, and the customer holding the one nobody meant to send.
    expect(balanceInvoiceDue({ ...quote, payment_policy: "commercial" }, lead, TODAY, T7)).toBe(
      false,
    );
  });

  it("an absent policy is residential, matching every other reader", () => {
    expect(balanceInvoiceDue({ ...quote, payment_policy: null }, lead, TODAY, T7)).toBe(true);
    expect(balanceInvoiceDue({ ...quote, payment_policy: "residential" }, lead, TODAY, T7)).toBe(
      true,
    );
  });
});

describe("chaseableQuotes — the QUOTED stage excludes commercial by the LIVE client", () => {
  /**
   * payment_policy is snapshotted AT ACCEPTANCE (snapshotPaymentPolicy), so on
   * every 'sent' quote the column is NULL and policyOfQuote(null) reads
   * residential — exactly backwards for the one stage that operates exclusively
   * on unaccepted quotes. Pre-acceptance the policy resolves LIVE from
   * clients.is_company via the quote's client (lead's client as fallback), the
   * same pattern /q's review gate documents. Post-acceptance the snapshot
   * governs: a client-type change must never alter an in-flight booking's
   * schedule — that is the whole point of snapshotting at acceptance.
   *
   * Exclusion from this one array is the WHOLE of the QUOTED stage for a lead:
   * pickQuote(allQuotes, lead.id, "sent") returns null, so no day-2/5/10 chase
   * email, no 30-day auto-lapse to lost, and no hand-to-human task. A
   * commercial quote is office-confirmed, not self-accepted (PRD §3.10 — no
   * accept action on /q), so a silent lapse would cancel a booking the office
   * may be mid-negotiation on; "excluded from the chase engine entirely"
   * covers the lapse too.
   */
  const commercialClients = new Set(["client-commercial"]);
  const leadClients = new Map<string, string | null>([
    ["lead-commercial", "client-commercial"],
    ["lead-residential", "client-residential"],
    ["lead-clientless", null],
  ]);

  const sentCommercial = {
    id: "q-comm",
    status: "sent",
    lead_id: "lead-commercial",
    payment_policy: null as string | null,
    client_id: null as string | null,
  };
  const sentResidential = {
    id: "q-resi",
    status: "sent",
    lead_id: "lead-residential",
    payment_policy: null as string | null,
    client_id: null as string | null,
  };

  it("a commercial client's sent quote is excluded — no chase email, no auto-lapse", () => {
    expect(chaseableQuotes([sentCommercial], commercialClients, leadClients)).toEqual([]);
  });

  it("residential control: a sent quote passes through untouched", () => {
    // Residential behaviour must be byte-identical before and after the live
    // resolve — the filter may only ever REMOVE commercial rows.
    expect(chaseableQuotes([sentResidential], commercialClients, leadClients)).toEqual([
      sentResidential,
    ]);
  });

  it("the quote's own client outranks the lead's — same order as snapshotPaymentPolicy", () => {
    const ownClient = { ...sentResidential, id: "q-own", client_id: "client-commercial" };
    expect(chaseableQuotes([ownClient], commercialClients, leadClients)).toEqual([]);
    const ownResidential = { ...sentCommercial, id: "q-own-r", client_id: "client-residential" };
    expect(chaseableQuotes([ownResidential], commercialClients, leadClients)).toEqual([
      ownResidential,
    ]);
  });

  it("no client anywhere resolves residential — the direction that chases", () => {
    // Guessing "commercial" for an unclassified lead would silently switch the
    // chase off — and the surface that would show the mistake is the chase
    // queue the guess just emptied (resolvePaymentPolicy's documented rule).
    const clientless = { ...sentCommercial, id: "q-none", lead_id: "lead-clientless" };
    expect(chaseableQuotes([clientless], commercialClients, leadClients)).toEqual([clientless]);
  });

  it("accepted quotes stay governed by the snapshot, never the live client", () => {
    // A client flipped to commercial AFTER acceptance must not pull an
    // in-flight residential booking out of its ladder mid-chase.
    const accepted = { ...sentCommercial, id: "q-acc", status: "accepted" };
    expect(chaseableQuotes([accepted], commercialClients, leadClients)).toEqual([accepted]);
  });

  it("an accepted commercial snapshot is still excluded", () => {
    const acceptedCommercial = {
      ...sentResidential,
      id: "q-acc-c",
      status: "accepted",
      payment_policy: "commercial" as string | null,
    };
    expect(chaseableQuotes([acceptedCommercial], commercialClients, leadClients)).toEqual([]);
  });

  it("a stray pre-acceptance snapshot saying commercial also excludes", () => {
    // Belt and braces: the snapshot should not exist on a sent quote, but if
    // one ever does say commercial, believing it fails in the safe direction
    // (a missed chase is recoverable by the office; a chase emailed to an
    // account-terms client is the defect).
    const stray = { ...sentResidential, id: "q-stray", payment_policy: "commercial" as string | null };
    expect(chaseableQuotes([stray], commercialClients, leadClients)).toEqual([]);
  });
});
