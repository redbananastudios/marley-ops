import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * updateLeadBrandAction vs createDraftQuote — the ref-stranding race.
 *
 * The action's original shape was check-then-act: COUNT the lead's issued
 * quote refs, then (later, in a separate statement) UPDATE leads.brand. A
 * concurrent createDraftQuote can interleave exactly between the two — read
 * the OLD brand, mint a ref with the OLD prefix, insert — and the brand
 * update then lands on top, stranding an issued MM ref on a Pitmans lead
 * (the one state the whole gate exists to forbid: a ref the customer has
 * seen changing meaning).
 *
 * The fix is the codebase's claim-first idiom (lib/quote/accept-flow.ts):
 * CLAIM the row with a CAS on the brand that was read, then RE-VERIFY refs
 * AFTER the claim and roll the claim back on any mismatch. Asserted as source
 * guards per the tests/components house convention (vitest runs node env, and
 * the property worth locking is structural ordering: claim → re-check →
 * everything else). Every lookup goes through at(), which FAILS on a missing
 * needle — a bare indexOf orders "before" everything and proves nothing.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const spanOf = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `anchor not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
};

const SRC = read("app/(dashboard)/leads/actions.ts");
const ACTION = spanOf(
  SRC,
  "export async function updateLeadBrandAction",
  "export async function setStandardCommsAction",
);

describe("updateLeadBrandAction closes the brand-change vs draft-quote race", () => {
  it("claims the lead row with a CAS on the brand it read, not a blind update", () => {
    // The write must carry the old brand as a filter — a concurrent brand
    // change (or any concurrent rewrite of the row) loses the CAS instead of
    // silently stacking a second swap on top of a state nobody re-checked.
    const claim = at(ACTION, '.eq("brand", lead.brand)', "the CAS filter on the brand update");
    const update = at(ACTION, "update({ brand: target.slug })", "the brand update itself");
    expect(update).toBeLessThan(claim);
  });

  it("re-verifies refs AFTER the claim and rolls the claim back on a mismatch", () => {
    const update = at(ACTION, "update({ brand: target.slug })", "the brand update");
    // The post-claim re-check looks for a ref row whose OWN brand disagrees
    // with the new slug — exactly the row a mid-flight createDraftQuote
    // (old-brand read → mint → insert) produces. A ref minted after the claim
    // carries the new brand (one variable feeds ref + row over there) and is
    // correctly left alone.
    const recheck = at(ACTION, '.neq("brand", target.slug)', "the post-claim mismatched-ref re-check");
    expect(update, "re-check must run AFTER the claim, or it proves nothing").toBeLessThan(recheck);
    // On a mismatch (or an unverifiable re-check — could-not-check must not
    // act as no-refs) the claim is rolled back to the brand that was read.
    const rollback = at(ACTION, "update({ brand: lead.brand })", "the claim rollback");
    expect(recheck).toBeLessThan(rollback);
    // The denormalised copies and the audit row come only after the verify —
    // never off the back of a claim that might yet be rolled back.
    const denorm = at(ACTION, 'from("appointments").update({ brand: target.slug })', "the appointments denorm write");
    expect(rollback).toBeLessThan(denorm);
  });

  it("keeps the cheap pre-check so the common already-issued case never flaps the brand", () => {
    const precheck = at(ACTION, '.not("quote_ref", "is", null)', "the pre-claim ref count");
    const update = at(ACTION, "update({ brand: target.slug })", "the brand update");
    expect(precheck).toBeLessThan(update);
  });
});
