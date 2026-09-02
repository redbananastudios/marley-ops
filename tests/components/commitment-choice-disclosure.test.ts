import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PRD §3.5: wherever a customer is shown the shared bank account, the
 * operating-company disclosure explains why the account name is not the
 * brand's own. `/q`'s BankPanel carries it (gated on `theme.groupLine` — the
 * default brand IS the operating company and renders nothing extra). The
 * settle-in-full bank block in CommitmentChoice is the SAME account on the
 * SAME page and dropped it — precisely when shown to a non-default-brand
 * customer, the one audience the sentence exists for.
 *
 * Source guards, per the house convention in tests/components (no jsdom):
 * the properties locked are structural — the disclosure exists, it is gated
 * on a prop rather than rendered unconditionally, the page derives that prop
 * from the same `theme.groupLine` gate BankPanel uses, and the sentence's
 * names arrive as DATA (this shared surface is under the brand-leak scan, so
 * a literal operating-company name would also fail there).
 */

const CHOICE = readFileSync(join(process.cwd(), "components/quote/commitment-choice.tsx"), "utf8");
const QPAGE = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

describe("the settle-in-full bank block carries the PRD §3.5 disclosure", () => {
  it("renders the group-explanation line beside the account name, from data", () => {
    // The same sentence shape BankPanel uses — brand name, operating company,
    // account name, reference — all interpolated, none literal.
    const idx = at(CHOICE, "is part of", "the operating-company disclosure sentence");
    const around = CHOICE.slice(Math.max(0, idx - 300), idx + 400);
    expect(around).toContain("disclosure.brandName");
    expect(around).toContain("disclosure.legalEntity");
    expect(around).toContain("bank.name");
    expect(around).toContain("quoteRef");
  });

  it("gates the disclosure on the prop — the default brand renders nothing extra", () => {
    const idx = at(CHOICE, "is part of", "the operating-company disclosure sentence");
    const before = CHOICE.slice(Math.max(0, idx - 300), idx);
    expect(before, "the sentence must sit behind a `disclosure ?` gate").toContain("disclosure ?");
  });

  it("takes the disclosure as a REQUIRED prop, so a call site cannot silently omit it", () => {
    // Optional would compile with the prop forgotten — which is exactly how
    // this block lost the sentence in the first place.
    expect(CHOICE).toMatch(/disclosure:\s*\{\s*brandName:\s*string;\s*legalEntity:\s*string\s*\}\s*\|\s*null/);
  });

  it("the page derives it from the same theme.groupLine gate BankPanel uses", () => {
    const call = at(QPAGE, "<CommitmentChoice", "the CommitmentChoice call site");
    const props = QPAGE.slice(call, call + 900);
    const disclosure = at(props, "disclosure={", "the disclosure prop at the call site");
    const value = props.slice(disclosure, disclosure + 300);
    expect(value).toContain("theme.groupLine");
    expect(value).toContain("theme.legalEntity");
  });

  it("carries no hardcoded operating-company name of its own", () => {
    // Belt and braces with the brand-leak scan: the sentence is data-driven.
    expect(CHOICE).not.toContain("MarleyMoves");
  });
});
