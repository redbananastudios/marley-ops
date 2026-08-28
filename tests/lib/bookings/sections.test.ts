import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBooking, owedNow, queueMoney, type QueueSignals } from "@/lib/bookings/queue";
import {
  groupMoneySections,
  moneySectionsOf,
  sectionTotal,
  OWED_SECTION_IDS,
  type MoneySectionId,
  type MoneySectionRow,
} from "@/lib/bookings/sections";

/**
 * The money lists on /bookings and /payments Due must add up to the headlines
 * printed above them. They did not: the headlines count OBLIGATIONS while the
 * lists were filtered by BUCKET, and a booking sits in exactly one bucket. So
 * a job owing something its rung is not named after had its money in a tile
 * and in no list — and on /bookings the tile and the section carried the same
 * title while showing different figures.
 *
 * Fixtures are built by running the real classifier and the real pricer over
 * one set of signals, so a row can never claim a bucket its money contradicts.
 */

const TODAY = "2026-08-20";

const base: QueueSignals = {
  depositPaidAt: "2026-08-01T10:00:00Z",
  hasRemovalAppt: false,
  apptDayUk: null,
  provisionalDate: null,
  approxWindow: null,
  approxMonth: null,
  commitmentPaidAt: null,
  commitmentInvoiceAmount: null,
  commitmentDueDate: null,
  dateReleasableAt: null,
  balancePaidAt: null,
  balanceInvoiceNumber: null,
};

const mk = (
  s: Partial<QueueSignals>,
  amounts: { deposit?: number; balanceAmount?: number } = {},
): MoneySectionRow => {
  const sig: QueueSignals = { ...base, ...s };
  return {
    bucket: classifyBooking(sig, TODAY),
    paymentPolicy: sig.paymentPolicy === "commercial" ? "commercial" : "residential",
    deposit: amounts.deposit ?? 100,
    owed: owedNow(
      {
        commitmentInvoiceAmount: Number(sig.commitmentInvoiceAmount ?? 0),
        commitmentPaidAt: sig.commitmentPaidAt,
        commitmentDueDate: sig.commitmentDueDate,
        dateReleasableAt: sig.dateReleasableAt,
        balanceAmount: amounts.balanceAmount ?? 0,
        balancePaidAt: sig.balancePaidAt,
        balanceInvoiceNumber: sig.balanceInvoiceNumber,
        hasRemovalAppt: sig.hasRemovalAppt,
        apptDayUk: sig.apptDayUk,
        paymentPolicy: sig.paymentPolicy,
        commercialDueDate: sig.commercialDueDate,
      },
      TODAY,
    ),
  };
};

/** Gate 9b: a move inside T-7 accepted online raises the balance invoice AT
 *  acceptance — deposit still unpaid, slot not yet in the diary. */
const lateBooking = mk(
  { depositPaidAt: null, balanceInvoiceNumber: "MM-2026-112-BAL" },
  { deposit: 100, balanceAmount: 1700 },
);
/** Gate 9c: settling in full raises the balance alongside the unpaid 25%. */
const settleInFull = mk(
  {
    hasRemovalAppt: true,
    apptDayUk: "2026-09-10",
    commitmentInvoiceAmount: 450,
    commitmentDueDate: "2026-08-30",
    balanceInvoiceNumber: "MM-2026-113-BAL",
  },
  { balanceAmount: 1350 },
);
/** QA-20260826-01: the 25% is raised on the customer's signature, which does
 *  not wait for the office to allocate a slot. */
const commitmentNoDiary = mk({ commitmentInvoiceAmount: 500, commitmentDueDate: "2026-08-10" });
const balanceOverdue = mk({ hasRemovalAppt: true, apptDayUk: "2026-08-15" }, { balanceAmount: 900 });
const commercialOverdue = mk(
  {
    depositPaidAt: null,
    paymentPolicy: "commercial",
    jobCompleted: true,
    hasRemovalAppt: true,
    apptDayUk: "2026-08-01",
    balanceInvoiceNumber: "MM-2026-114-BAL",
    commercialDueDate: "2026-08-10",
  },
  { deposit: 0, balanceAmount: 2400 },
);
const commercialInvoiced = mk(
  {
    depositPaidAt: null,
    paymentPolicy: "commercial",
    jobCompleted: true,
    hasRemovalAppt: true,
    apptDayUk: "2026-08-01",
    balanceInvoiceNumber: "MM-2026-115-BAL",
    commercialDueDate: "2026-09-30",
  },
  { deposit: 0, balanceAmount: 3000 },
);
const allSet = mk({ hasRemovalAppt: true, apptDayUk: "2026-10-30" }, { balanceAmount: 1500 });

const LEDGER = [
  lateBooking,
  settleInFull,
  commitmentNoDiary,
  balanceOverdue,
  commercialOverdue,
  commercialInvoiced,
  allSet,
];

describe("money section membership", () => {
  it("the late booking is in the balance list its own tile counts", () => {
    // The defect verbatim: this row bucketed `deposit_outstanding`, so
    // /bookings rendered "Balance to collect £1,700" above a "Balance to
    // collect" section reading "0 — nothing here, all clear", with the row
    // itself under Deposits outstanding showing only £100.
    expect(lateBooking.bucket).toBe("deposit_outstanding");
    expect(moneySectionsOf(lateBooking).sort()).toEqual(["balance_due", "deposits_outstanding"]);
    const s = groupMoneySections([lateBooking]);
    expect(sectionTotal(s.balance_due, "balance_due")).toBe(1700);
    expect(sectionTotal(s.deposits_outstanding, "deposits_outstanding")).toBe(100);
  });

  it("the 25% raised before the slot is booked has a list, not just a tile", () => {
    expect(commitmentNoDiary.bucket).toBe("no_date");
    expect(moneySectionsOf(commitmentNoDiary)).toEqual(["commitment_overdue"]);
  });

  it("a job owing the 25% and a balance is in both lists, each for its own share", () => {
    expect(moneySectionsOf(settleInFull).sort()).toEqual(["balance_due", "commitment_due"]);
    const s = groupMoneySections([settleInFull]);
    // Never its whole debt twice — that would double the money on any page
    // that adds the sections up.
    expect(sectionTotal(s.commitment_due, "commitment_due")).toBe(450);
    expect(sectionTotal(s.balance_due, "balance_due")).toBe(1350);
  });

  it("commercial money keeps its own lists — it is never folded into a chase queue", () => {
    // Past its terms this is our own credit control; a commercial client is
    // never chased by email (PRD §3.10).
    expect(moneySectionsOf(commercialOverdue)).toEqual(["commercial_overdue"]);
    expect(moneySectionsOf(commercialInvoiced)).toEqual(["commercial_due"]);
    const s = groupMoneySections(LEDGER);
    expect(s.balance_overdue).not.toContain(commercialOverdue);
    expect(s.balance_due).not.toContain(commercialInvoiced);
    expect(s.deposits_outstanding).not.toContain(commercialOverdue);
  });

  it("a booking owing nothing today is in no money list at all", () => {
    expect(allSet.bucket).toBe("all_set");
    expect(moneySectionsOf(allSet)).toEqual([]);
  });

  it("an obligation is in exactly one list — overdue or to collect, never both", () => {
    const s = groupMoneySections(LEDGER);
    for (const r of LEDGER) {
      const ids = moneySectionsOf(r);
      const inGroup = (group: readonly MoneySectionId[]) => ids.filter((id) => group.includes(id)).length;
      expect(inGroup(["commitment_overdue", "commitment_due"])).toBeLessThanOrEqual(1);
      expect(inGroup(["balance_overdue", "balance_due"])).toBeLessThanOrEqual(1);
      expect(inGroup(["commercial_overdue", "commercial_due"])).toBeLessThanOrEqual(1);
    }
    // And no row is listed twice inside one section.
    for (const id of OWED_SECTION_IDS) {
      expect(new Set(s[id]).size).toBe(s[id].length);
    }
  });
});

describe("the sections reconcile to the headlines", () => {
  const s = groupMoneySections(LEDGER);
  const money = queueMoney(LEDGER);
  const total = (id: MoneySectionId) => sectionTotal(s[id], id);

  it("each section carries the £ its name promises", () => {
    expect(total("deposits_outstanding")).toBe(100);
    expect(total("commitment_overdue")).toBe(500);
    expect(total("commitment_due")).toBe(450);
    expect(total("balance_overdue")).toBe(900);
    expect(total("balance_due")).toBe(3050); // 1,700 late booking + 1,350 settle-in-full
    expect(total("commercial_overdue")).toBe(2400);
    expect(total("commercial_due")).toBe(3000);
  });

  it("the owed sections add up to /payments 'Owed right now'", () => {
    // The reader is invited to add the section totals up, so they have to
    // reach the headline. Bucket-filtered lists reached £1,350 short of it.
    expect(OWED_SECTION_IDS.reduce((sum, id) => sum + total(id), 0)).toBe(money.owedNow);
    expect(money.owedNow).toBe(10_300);
  });

  it("the two /bookings money tiles decompose into the sections beneath them", () => {
    expect(total("commitment_overdue") + total("commitment_due")).toBe(money.commitment);
    expect(total("balance_overdue") + total("balance_due") + total("commercial_overdue") + total("commercial_due")).toBe(
      money.balance,
    );
  });

  it("the danger sections hold every penny of the Overdue tile", () => {
    // An empty danger section renders as nothing at all, so a red "Overdue
    // £2,400 — chase today" with no overdue section on screen was reachable
    // the moment commercial money joined the headline with no list to hold it.
    expect(total("commitment_overdue") + total("balance_overdue") + total("commercial_overdue")).toBe(money.overdue);
    expect(money.overdue).toBe(3800);
    const dangerRows = [...s.commitment_overdue, ...s.balance_overdue, ...s.commercial_overdue];
    expect(dangerRows.length).toBeGreaterThan(0);
  });

  it("deposits stay outside the owed total", () => {
    // A deposit secures a booking rather than falling due on a date (Peter,
    // 2026-08-20), so it is reported beside the headline, never inside it.
    expect(total("deposits_outstanding")).toBe(money.depositsOutstanding);
    expect(OWED_SECTION_IDS).not.toContain("deposits_outstanding");
  });

  it("holds on an empty ledger", () => {
    const empty = groupMoneySections([]);
    for (const id of OWED_SECTION_IDS) expect(empty[id]).toEqual([]);
    expect(queueMoney([]).owedNow).toBe(0);
  });
});

describe("/bookings tiles and sections cannot claim to be the same thing", () => {
  /**
   * PR #148 moved the TILES to per-obligation money and deliberately left the
   * LISTS on buckets; PR #153 then renamed a section to match its tile
   * exactly. Together they put "Balance to collect £1,700" directly above
   * "Balance to collect — 0 — Nothing here, all clear" on one page. A tile is
   * a TOTAL over obligations and a section is one rung of it, so a tile may
   * only borrow a section's title when it prints that section's own total.
   */
  const page = readFileSync(join(process.cwd(), "app/(dashboard)/bookings/page.tsx"), "utf8");

  /** The opening tags of one component, as raw attribute text. */
  const openTags = (tag: string): string[] =>
    page
      .split(`<${tag}`)
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf(">")));

  const stringAttr = (chunk: string, name: string): string | null =>
    chunk.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

  /** A `name={…}` attribute's expression, brace-matched so a nested call
   *  survives intact. */
  const exprAttr = (chunk: string, name: string): string | null => {
    const at = chunk.indexOf(`${name}={`);
    if (at < 0) return null;
    const from = at + name.length + 1;
    let depth = 0;
    for (let i = from; i < chunk.length; i++) {
      if (chunk[i] === "{") depth++;
      else if (chunk[i] === "}" && --depth === 0) return chunk.slice(from + 1, i);
    }
    return null;
  };

  const sectionIdOf = (expr: string | null): string | null =>
    expr?.match(/sectionSum\("([a-z_]+)"\)/)?.[1] ?? null;

  const tiles = openTags("Stat").map((c) => ({ label: stringAttr(c, "label"), value: exprAttr(c, "value") }));
  const sections = openTags("Section").map((c) => ({ title: stringAttr(c, "title"), total: exprAttr(c, "total") }));

  it("parses the page it is guarding", () => {
    // Without this the whole guard passes vacuously the day the markup moves.
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(sections.length).toBeGreaterThanOrEqual(8);
    expect(tiles.every((t) => t.label && t.value)).toBe(true);
    expect(sections.every((s) => s.title)).toBe(true);
  });

  it("a tile sharing a section's title prints that section's own total", () => {
    for (const tile of tiles) {
      const twin = sections.find((s) => s.title === tile.label);
      if (!twin) continue;
      const id = sectionIdOf(tile.value);
      expect(
        id,
        `the "${tile.label}" tile repeats a section title but does not read that section's total — ` +
          `rename one of them, or point the tile at sectionSum(...)`,
      ).not.toBeNull();
      expect(sectionIdOf(twin.total), `the "${tile.label}" section must total the same obligation`).toBe(id);
    }
  });

  it("every money section prints a total, so the tiles above decompose into them", () => {
    const money = ["25% overdue", "25% to collect", "Balance overdue", "Balance to collect", "Deposits outstanding"];
    const untotalled = sections.filter((s) => s.title && money.includes(s.title) && !sectionIdOf(s.total));
    expect(
      untotalled.map((s) => s.title),
      "a money section with no total leaves the reader nothing to add up",
    ).toEqual([]);
  });
});

/**
 * Gate 10a's `commercial_terms_unknown` bucket landed in a lane that could
 * not see this seam, and the seam landed in a lane that could not see the
 * bucket. Held in its own ledger rather than added to LEDGER above, so the
 * literal anchors there keep meaning what they were written to mean.
 */
describe("a commercial invoice with no terms date", () => {
  const undated = mk(
    {
      depositPaidAt: null,
      paymentPolicy: "commercial",
      jobCompleted: true,
      hasRemovalAppt: true,
      apptDayUk: "2026-08-01",
      balanceInvoiceNumber: "MM-2026-116-BAL",
      commercialDueDate: null,
    },
    { deposit: 0, balanceAmount: 800 },
  );

  it("is listed as unknown, never as in terms", () => {
    expect(undated.bucket).toBe("commercial_terms_unknown");
    expect(
      moneySectionsOf(undated),
      "a missing terms date rendered as \"invoiced, inside the client's terms\" — the reassuring answer, from knowing nothing",
    ).toEqual(["commercial_terms_unknown"]);
  });

  it("keeps its money in the owed total — only the LATENESS claim is withheld", () => {
    const money = queueMoney([undated]);
    // The invoice is real and unpaid, so hiding it would be the opposite
    // failure: an unbilled customer nobody can see.
    expect(money.owedNow).toBe(800);
    expect(money.overdue, "overdue is a claim about a date, and there is no date to make it about").toBe(0);
  });

  it("still partitions: the owed sections reach the headline, the danger ones reach Overdue", () => {
    const ledger = [...LEDGER, undated];
    const s = groupMoneySections(ledger);
    const money = queueMoney(ledger);
    expect(OWED_SECTION_IDS.reduce((sum, id) => sum + sectionTotal(s[id], id), 0)).toBe(money.owedNow);
    const danger: MoneySectionId[] = [
      "commitment_overdue",
      "balance_overdue",
      "commercial_overdue",
    ];
    expect(danger.reduce((sum, id) => sum + sectionTotal(s[id], id), 0)).toBe(money.overdue);
    expect(s.commercial_terms_unknown, "the undated row must be in exactly one list").toHaveLength(1);
  });
});
