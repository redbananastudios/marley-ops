import type { BookingBucket, OwedNow } from "@/lib/bookings/queue";

/**
 * Which money LIST a booking belongs in, shared verbatim by /bookings and the
 * /payments Due tab so the two can never list the same job differently.
 *
 * The rule this file exists to enforce: a figure in a headline must be
 * findable in a list. `queueMoney` totals per OBLIGATION while the lists were
 * built per BUCKET, and a booking sits in exactly one bucket — so the two
 * disagreed the moment a job owed something its rung is not named after. A
 * gate 9b late booking accepted online raises the balance invoice AT
 * acceptance, with the deposit unpaid and no slot in the diary: it classifies
 * `deposit_outstanding`, and /bookings rendered "Balance to collect £1,700"
 * directly above a "Balance to collect" section reading "0 — nothing here,
 * all clear", with the row itself under Deposits outstanding showing £100.
 * On /payments the same row made the section totals stop adding up to the
 * headline printed above them.
 *
 * So membership is by obligation: a booking appears in as many money lists as
 * it owes money in, each carrying that obligation's own £. Bucket membership
 * still counts — a rung that NAMES an obligation always claims its rows, so
 * nothing the classifier bucketed can fall off the page even when it owes £0
 * (a gate 9a small job whose acceptance ask already took the whole price).
 * Adding £0 leaves every total untouched.
 *
 * The sections partition the money exactly:
 *   commitment_overdue + commitment_due                      = queueMoney.commitment
 *   balance_overdue + balance_due + commercial_*             = queueMoney.balance
 *   the three *_overdue sections                             = queueMoney.overdue
 *   deposits_outstanding                                     = queueMoney.depositsOutstanding
 * Deposits stay disjoint from all of it (Peter, 2026-08-20) — a deposit
 * secures a booking rather than falling due on a date, so it is never part of
 * "owed right now". Proven in tests/lib/bookings/sections.test.ts.
 */

export type MoneySectionId =
  | "deposits_outstanding"
  | "commitment_overdue"
  | "commitment_due"
  | "balance_overdue"
  | "balance_due"
  | "commercial_overdue"
  | "commercial_due"
  /** Commercial, invoiced, terms date MISSING — so whether it is late is
   *  unknown rather than answered. Its own section for the same reason it has
   *  its own bucket: "in terms" and "we cannot tell" must not share a
   *  rendering. It carries owed money (the full invoice) but never an overdue
   *  claim, so it belongs to `owedNow` and not to `overdue`. */
  | "commercial_terms_unknown";

/** Every section that carries `owedNow` money. Deposits are deliberately
 *  absent: they are reported beside the headline, never inside it. */
export const OWED_SECTION_IDS: readonly MoneySectionId[] = [
  "commitment_overdue",
  "commitment_due",
  "balance_overdue",
  "balance_due",
  "commercial_overdue",
  "commercial_due",
  "commercial_terms_unknown",
];

/** The commercial ladder's own sections. Named once so a page combining them
 *  into a single list cannot total a different set than it renders — and so a
 *  fourth commercial section can never be added without both pages seeing it. */
export const COMMERCIAL_SECTION_IDS: readonly MoneySectionId[] = [
  "commercial_terms_unknown",
  "commercial_overdue",
  "commercial_due",
];

export interface MoneySectionRow {
  bucket: BookingBucket;
  paymentPolicy: "residential" | "commercial";
  deposit: number;
  owed: OwedNow;
}

/** The money sections a row belongs in — none, one, or several. */
export function moneySectionsOf(r: MoneySectionRow): MoneySectionId[] {
  const commercial = r.paymentPolicy === "commercial";
  const ids: MoneySectionId[] = [];

  if (r.bucket === "deposit_outstanding") ids.push("deposits_outstanding");

  // The 25% rungs imply their obligation (a `commitment_*` bucket needs an
  // invoiced, unpaid amount), so the bucket test only ever agrees with the
  // owed test here. It is kept so the rung cannot be orphaned if either rule
  // is later relaxed on one side only.
  if (r.owed.commitmentOverdue > 0 || r.bucket === "commitment_overdue") ids.push("commitment_overdue");
  else if (r.owed.commitment > 0 || r.bucket === "commitment_due") ids.push("commitment_due");

  // Commercial is answered separately, never folded into the residential
  // balance lists: past its terms it is OUR credit control, and a commercial
  // client is never chased by email (PRD §3.10). Folding it in would put it
  // in a section whose whole purpose is a customer chase.
  if (commercial) {
    // Undated FIRST, and it wins outright. `owedNow` deliberately withholds
    // the overdue claim when there is no terms date to base it on, so such a
    // row reaches the `owed.balance` test below and would land in
    // "Commercial invoiced — inside the client's terms": the reassuring
    // rendering, produced by having no information at all. That is exactly the
    // guess `commercial_terms_unknown` exists to refuse.
    if (r.bucket === "commercial_terms_unknown") ids.push("commercial_terms_unknown");
    else if (r.owed.balanceOverdue > 0 || r.bucket === "commercial_overdue") ids.push("commercial_overdue");
    else if (r.owed.balance > 0 || r.bucket === "commercial_invoiced") ids.push("commercial_due");
  } else {
    if (r.owed.balanceOverdue > 0 || r.bucket === "balance_overdue") ids.push("balance_overdue");
    else if (r.owed.balance > 0 || r.bucket === "balance_due") ids.push("balance_due");
  }

  return ids;
}

/** The £ a row contributes to ONE section — the obligation that section is
 *  named after, never the row's whole debt. A job owing the 25% and an early
 *  balance at once (gate 9c) shows £450 in one list and £1,700 in another;
 *  printing its total in both would double it on any page that adds them. */
export function sectionAmount(r: MoneySectionRow, id: MoneySectionId): number {
  switch (id) {
    case "deposits_outstanding":
      return r.deposit;
    case "commitment_overdue":
    case "commitment_due":
      return r.owed.commitment;
    default:
      return r.owed.balance;
  }
}

export type MoneySections<T> = Record<MoneySectionId, T[]>;

/** Group a ledger into its money sections, preserving input order. */
export function groupMoneySections<T extends MoneySectionRow>(rows: readonly T[]): MoneySections<T> {
  const out: MoneySections<T> = {
    deposits_outstanding: [],
    commitment_overdue: [],
    commitment_due: [],
    balance_overdue: [],
    balance_due: [],
    commercial_overdue: [],
    commercial_due: [],
    commercial_terms_unknown: [],
  };
  for (const r of rows) for (const id of moneySectionsOf(r)) out[id].push(r);
  return out;
}

/** The £ total of one section — what its header prints, and what a reader
 *  adding the sections up is entitled to reach. */
export function sectionTotal<T extends MoneySectionRow>(rows: readonly T[], id: MoneySectionId): number {
  return rows.reduce((s, r) => s + sectionAmount(r, id), 0);
}
