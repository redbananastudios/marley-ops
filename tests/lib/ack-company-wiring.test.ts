import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dateConfirmAcks, storageAcks, crateStorageAcks } from "@/lib/signatures";

/**
 * The two tick-boxes that NAME A COMPANY — the storage lien clause (disposal
 * and sale of the customer's goods) and the date-confirmation clause (up to 25%
 * of what they have paid may be retained) — must name the brand the customer is
 * actually dealing with, on every channel that renders or records them.
 *
 * `lib/signatures.ts` already takes the company as data, and
 * `tests/lib/signatures.test.ts` pins the builders themselves: unbranded calls
 * render today's exact bytes, branded calls really substitute. That is only
 * half the story. A brand-aware builder with no caller passing a brand is
 * INDISTINGUISHABLE, in every rendered output, from a builder that was never
 * made brand-aware at all — which is exactly how `dateConfirmAcks(companyName)`
 * shipped with zero callers passing a company.
 *
 * So this file asserts the OTHER half: the wiring. Each surface reads its
 * company from the record's own brand, and no surface still reaches for the
 * unbranded module constant. The house rule these tests exist for: an unchanged
 * rendered output does not prove the new source is being read.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Collapse runs of whitespace so an assertion survives Prettier re-wrapping. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * Source with its comments removed, for the assertions that say a name must
 * appear NOWHERE.
 *
 * These files document the constant they replaced, by name, so that the next
 * reader knows what the shape used to be and why it changed. A raw-text scan
 * reads that history as the defect itself and fails on a correct file — which
 * is a test that punishes the explanation rather than the behaviour. The
 * assertions here are about what the code DOES.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The crate ack call passing the RESOLVED company as its third argument.
 *
 * `[^;]*?` rather than `[^)]*`: the minimum argument contains its own parens
 * (`Number(l.min_days ?? rates.crateMinDays)`), which a `[^)]*` form cannot
 * cross, so it failed against perfectly correct code. Stopping at `;` keeps it
 * inside the one statement, so it still cannot be satisfied by some other call
 * further down the file.
 */
const CRATE_ACK_TAKES_COMPANY =
  /crateStorageAcks\([^;]*?gbpInc\(rates\.handlingEventInc\), company,?\s*\)/;

const S_PAGE = "app/s/[token]/page.tsx";
const S_ACTIONS = "app/s/[token]/actions.ts";
const STORAGE_ACTIONS = "app/(dashboard)/storage/actions.ts";
const MANAGE_LET = "components/storage/manage-let-dialog.tsx";
const Q_PAGE = "app/q/[token]/page.tsx";
const DATE_CARD = "components/quote/date-confirm-card.tsx";
const DATE_STATUS = "components/quote/date-confirm-status.tsx";
const CHASE = "lib/comms/commitment-chase-email.ts";

describe("the builders really substitute (the half a rendered diff cannot show)", () => {
  // Guards the assumption every wiring assertion below rests on: threading a
  // company through actually changes the clause. If this fails, the wiring is
  // correct and pointless.
  it("mutating the company changes the lien and date-confirm clauses", () => {
    const lien = storageAcks("Pitmans Removals")[1].label;
    expect(lien).toContain("Pitmans Removals may");
    expect(lien).not.toContain("Marley Moves");
    expect(crateStorageAcks({ kind: "calendar_month", days: 28 }, "£60", "Pitmans Removals")[1].label).toBe(lien);

    const confirm = dateConfirmAcks("Pitmans Removals")[0].label;
    expect(confirm).toContain("and Pitmans Removals cannot re-book the day");
    expect(confirm).not.toContain("Marley Moves");
  });

  it("and an absent company still renders the default brand's wording", () => {
    expect(storageAcks()[1].label).toContain("Marley Moves may");
    expect(dateConfirmAcks()[0].label).toContain("and Marley Moves cannot re-book the day");
  });
});

describe("storage agreement — RENDERED and RECORDED resolve the same company", () => {
  /**
   * `signatures.ack_labels` is the sole record of what was agreed. The remote
   * action re-derived it from the UNBRANDED constants while the page rendered
   * the brand's own name, so a second brand's customer read one clause and
   * signed another. Both halves now resolve through the SAME two functions from
   * the SAME column, which is what makes them provably identical rather than
   * merely similar today.
   */
  const RESOLUTION = /pageTheme\(await getBrandOrDefault\((admin|sb), let_\.brand\)\)/;

  it("/s: the page and the action resolve the let's brand identically", () => {
    expect(flat(read(S_PAGE))).toMatch(RESOLUTION);
    const src = read(S_ACTIONS);
    expect(flat(src), "the remote action does not resolve the let's brand").toMatch(RESOLUTION);
    // It cannot resolve a column it never selects.
    expect(src).toContain("min_kind, brand");
  });

  it("/s: the action feeds that company into BOTH ack sets", () => {
    const src = flat(read(S_ACTIONS));
    expect(src).toContain("storageAcks(company)");
    expect(src).toMatch(CRATE_ACK_TAKES_COMPANY);
  });

  it("in person: the action resolves the same way and selects the same column", () => {
    const src = read(STORAGE_ACTIONS);
    expect(flat(src)).toMatch(RESOLUTION);
    expect(src).toContain("min_kind, brand");
    expect(flat(src)).toContain("storageAcks(company)");
    expect(flat(src)).toMatch(CRATE_ACK_TAKES_COMPANY);
  });

  it("in person: the dialog renders from the let's PERSISTED brand, not the unsaved selector", () => {
    const src = flat(read(MANAGE_LET));
    expect(src).toContain("const letBrandSlug = (let_.brand ?? \"\").trim()");
    expect(src).toContain("brands.find((b) => b.slug === letBrandSlug)");
    expect(src).toContain("storageAcks(signingCompanyName)");
    expect(src).toContain("gbpInc(rates.handlingEventInc), signingCompanyName,");
    // The dropdown state is `brand`; the ack must never be built from it, or the
    // dialog would show one company and the server record another.
    expect(src).not.toContain("storageAcks(brand)");
  });

  it("in person: an unresolvable brand FAILS CLOSED rather than rendering the default", () => {
    // `brands` is empty both in single-brand mode and on a FAILED brands read
    // (the storage page uses listActiveBrandsOrEmpty), so a missing row is "I
    // could not check", not "it must be Marley" — while the server would go on
    // to record the real name. Refusing is the only answer that cannot diverge.
    const src = flat(read(MANAGE_LET));
    expect(src).toContain("letBrandSlug === DEFAULT_BRAND || !!letBrandRow");
    expect(src).toContain("const signReady = companyKnown &&");
    expect(src).toContain("disabled={!companyKnown}");
  });

  it("no storage surface still reaches for the unbranded constant", () => {
    for (const file of [S_ACTIONS, STORAGE_ACTIONS, MANAGE_LET, S_PAGE]) {
      expect(code(file), file).not.toContain("STORAGE_ACKS");
    }
  });
});

describe("date confirmation — every renderer of the 25% clause takes a company", () => {
  it("/q passes the page theme's brand name into the customer's card", () => {
    const src = flat(read(Q_PAGE));
    expect(src).toContain("<DateConfirmCard");
    expect(src, "the /q card still renders the default company's clause").toContain(
      "companyName={theme.name}",
    );
    // And that `theme` is the QUOTE's brand, not some default literal —
    // otherwise the assertion above passes for a theme resolved from nothing,
    // which is the inert-switch shape this whole file exists to catch.
    //
    // Scoped to the PAGE COMPONENT deliberately. `generateMetadata` resolves a
    // theme of its own with byte-identical text, so a whole-file scan is
    // satisfied by the tab title alone and would stay green with the body's
    // resolution gutted — and the body's theme is the one that reaches the ack.
    const body = src.slice(src.indexOf("export default async function AcceptPage"));
    expect(body, "the /q page body does not resolve the theme from the quote's brand").toContain(
      "pageTheme(quote ? await getBrandOrDefault(sb, quote.brand) : null)",
    );
  });

  it("the customer card builds its ack from that prop", () => {
    const src = flat(read(DATE_CARD));
    expect(src).toContain("dateConfirmAcks(companyName)");
    expect(src).toContain("ackList.map((a) =>");
    expect(src).toContain("ackList.every((a) => acks[a.key])");
  });

  it("the office-side renderer builds its ack from a company too", () => {
    const src = flat(read(DATE_STATUS));
    expect(src).toContain("dateConfirmAcks(companyName)");
    expect(src).toContain("companyName={companyName}");
  });

  it("neither renderer still maps the module constant", () => {
    for (const file of [DATE_CARD, DATE_STATUS]) {
      expect(code(file), file).not.toContain("DATE_CONFIRM_ACKS");
    }
  });
});

describe("commitment chase — the quoted clause is a function of the brand", () => {
  it("no module-level constant bakes the default brand's wording at import", () => {
    // Comments stripped: this file explains, at length, the constant it
    // replaced — naming it is the documentation, not the defect.
    const src = code(CHASE);
    expect(src).not.toContain("COMMITMENT_CHASE_WARNING");
    expect(src).not.toMatch(/DATE_CONFIRM_ACKS\[0\]/);
    expect(flat(src)).toContain("dateConfirmAcks(t.name)[0].label");
  });

  it("both builders read it from the theme they already resolved", () => {
    const src = flat(read(CHASE));
    // Once per builder — the composed text/variables and the fallback HTML.
    expect(src.match(/const warning = warningFor\(t\);/g)).toHaveLength(2);
    expect(src).toContain("DATE_CONFIRM_ACK: escapeHtml(warning)");
  });
});
