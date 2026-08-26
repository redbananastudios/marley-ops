import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { buildQuoteDocDef } from "@/lib/quote/pdf-client";
import { assembleJobSheetData } from "@/lib/job-sheet-data";
import { buildJobSheetDocDef } from "@/lib/job-sheet-docdef";
import { buildDaySheetDocDef } from "@/lib/crew-sheet/daily-docdef";
import type { DaySheetMeta } from "@/lib/crew-sheet/daily-docdef";
import type { CrewDaySheet } from "@/lib/crew-sheet/daily-data";
import { buildStatementDocDef } from "@/lib/staff/statement-docdef";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";
import { tintTowardsWhite, type DocBrand } from "@/lib/pdf/doc-brand";

/**
 * Gate-14 spec tests (multi-brand PRD §3.6) — the cross-document contract, as
 * distinct from each doc-def's own unit tests:
 *
 *   1. JOB documents (quote, job sheet): absent brand ≡ null ≡ undefined,
 *      compared INCLUDING function-valued nodes. The per-file tests compare
 *      JSON.stringify output, which silently drops footer/header closures and
 *      the table-layout colour functions — exactly where the soft brand tints
 *      live — so a parity break inside a layout function would pass them.
 *      resolveFns() invokes every function and compares its output too.
 *   2. A non-default brand substitutes name/colour/legal line and includes the
 *      group_line; once the brand's own group/legal text is set aside, ZERO
 *      default-brand identity remains anywhere in the resolved tree.
 *   3. GROUP documents (crew day sheet, contractor statement) take NO brand
 *      parameter — enforced at COMPILE time via the HasBrand probe below: if a
 *      future edit adds a `brand` field to their data shapes, the `false`
 *      assignments stop type-checking and `tsc --noEmit` fails the pipeline.
 *   4. The day sheet marks each job's brand ONLY when the day spans 2+ brands
 *      — including the all-second-brand day, which is single-brand and must
 *      stay marker-free (unmarked means single-brand, not default-brand).
 */

// ── Function-aware doc-def resolution ──────────────────────────────────────
// pdfmake doc-defs carry closures (footer(page, pages), layout colour/padding
// functions). Replace each with its invoked result so deep comparison and
// leak scans cover what those closures would render. Closures here either
// ignore their arguments or take (page, pages) numbers — with one layout
// shape reading (i, node.table.body), so that node shape is the fallback
// call. A closure that still throws resolves to a deterministic tag, which
// compares equal on both sides of a parity check rather than hiding.
function resolveFns(node: unknown): unknown {
  if (typeof node === "function") {
    const fn = node as (...args: unknown[]) => unknown;
    try {
      return { fnResult: resolveFns(fn(1, 2)) };
    } catch {
      try {
        return { fnResult: resolveFns(fn(1, { table: { body: [] } })) };
      } catch {
        return "fn-threw";
      }
    }
  }
  if (Array.isArray(node)) return node.map(resolveFns);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, resolveFns(v)]),
    );
  }
  return node;
}
const flatten = (node: unknown): string => JSON.stringify(resolveFns(node));

/** Default-brand identity that must never survive into a branded document. */
const DEFAULT_IDENTITY = [
  "#C03838", // accent red
  "#FDF1F1", // redSoft panel fill (lives in layout closures)
  "#F1D8D8", // acceptance strip border tint
  "#F1C7C7", // acceptance box border tint
  "01747 637070",
  "hello@marleymoves.co.uk",
  "www.marleymoves.co.uk",
];

/** A Pitmans-shaped plain DocBrand — the PRD §2 second brand as data. The
 *  colour is the WCAG-picked primary (yellow accent fails white legibility). */
const pitmans: DocBrand = {
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  shortName: "Pitmans",
  groupLine: "Part of the Marley Group",
  legalLine:
    "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266. VAT 520 2213 58.",
  phone: "01258 858564",
  email: "info@pitmansremovals.co.uk",
  websiteUrl: "https://pitmansremovals.co.uk",
  colour: "#2B2B76",
};

/** Everything after the brand's own row values are set aside must be free of
 *  the default brand: its group/legal lines legitimately name the group, and
 *  the pdf `creator` names the producing APP ("Marley Ops") for every brand —
 *  app chrome per PRD §2, same rationale as the job sheet's video-QR copy. */
function residue(flat: string, brand: DocBrand): string {
  return flat
    .split(brand.groupLine)
    .join("")
    .split(brand.legalLine)
    .join("")
    .split("Marley Ops")
    .join("");
}

// ── 1 + 2: the quote PDF ───────────────────────────────────────────────────

describe("gate-14 spec — quote PDF doc-def", () => {
  const b = computeQuote(
    {
      vehicle: "2luton",
      packing: "full",
      sevenFiveT: 0,
      transitVans: 0,
      days: 2,
      deadMiles: 10,
      jobMiles: 10,
      collectAccessM: 0,
      destAccessM: 0,
      collectType: "house",
      collectFloor: "ground",
      destType: "house",
      destFloor: "ground",
      congestion: false,
      tolls: 0,
      parking: 0,
      discount: 0,
      vatEnabled: true,
    },
    DEFAULT_PRICING,
  );
  const values = defaultQuoteValues();
  const meta = { quoteRef: "MM-260826-001", vatNumber: "GB 123 4567 89", depositAmount: 100 };

  it("absent brand ≡ null ≡ undefined — structural identity INCLUDING function-valued nodes", () => {
    const absent = resolveFns(buildQuoteDocDef(values, b, meta));
    expect(resolveFns(buildQuoteDocDef(values, b, { ...meta, brand: null }))).toEqual(absent);
    expect(resolveFns(buildQuoteDocDef(values, b, { ...meta, brand: undefined }))).toEqual(absent);
  });

  it("the no-brand document IS today's: default identity pinned, including inside layout closures", () => {
    const flat = flatten(buildQuoteDocDef(values, b, meta));
    for (const literal of DEFAULT_IDENTITY) {
      expect(flat, `default doc must carry ${literal}`).toContain(literal);
    }
    expect(flat).toContain("Marley Moves Ltd  |  Company No. 15914266"); // footer closure output
  });

  it("a non-default brand substitutes name, colour, legal line — and includes the group line", () => {
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, brand: pitmans }));
    expect(flat).toContain(pitmans.name);
    expect(flat).toContain(pitmans.colour);
    expect(flat).toContain(pitmans.legalLine.slice(0, 60)); // footer closure output
    expect(flat).toContain(pitmans.groupLine);
    // The soft fills are TINTS of the brand colour — the documented data rule.
    expect(flat).toContain(tintTowardsWhite(pitmans.colour, 0.92)); // panel fill
    expect(flat).toContain(tintTowardsWhite(pitmans.colour, 0.78)); // strip border
    expect(flat).toContain(tintTowardsWhite(pitmans.colour, 0.7)); // box border
  });

  it("a branded quote carries ZERO default-brand identity, even inside closures", () => {
    const flat = flatten(buildQuoteDocDef(values, b, { ...meta, brand: pitmans }));
    for (const literal of DEFAULT_IDENTITY) {
      expect(flat, `branded doc must not carry ${literal}`).not.toContain(literal);
    }
    // Once the brand's own group/legal text is set aside, no "Marley" remains.
    // (The bank card's MARLEYMOVES LTD is the deliberate PRD §2 shared account.)
    expect(residue(flat, pitmans)).not.toContain("Marley");
  });
});

// ── 1 + 2: the job sheet (the JOB doc-def pair) ────────────────────────────

describe("gate-14 spec — job sheet doc-def", () => {
  const values = defaultQuoteValues();
  values.customer = { name: "Jane Doe", phone: "07572 000000", email: "" };
  values.job.collectAddr = "1 High Street, Gillingham, SP8 4GH";
  const data = assembleJobSheetData(
    {
      id: "a1",
      title: "Removal — Jane Doe",
      starts_at: "2026-08-26T08:00:00+01:00",
      ends_at: "2026-08-26T17:00:00+01:00",
      all_day: true,
    },
    {
      name: "Jane Doe",
      phone: "07572 000000",
      from_address: "1 High Street, Gillingham",
      from_postcode: "SP8 4GH",
      to_address: "2 Low Road, Poole",
      to_postcode: "BH1 4DQ",
      notes: null,
    },
    { quote_ref: "MM-260826-001", moving_date: "2026-08-26", state_blob: values },
    ["Jack"],
    ["Luton 1 (AB12 CDE)"],
  );

  it("absent brand ≡ null ≡ undefined — structural identity INCLUDING function-valued nodes", () => {
    const absent = resolveFns(buildJobSheetDocDef(data));
    expect(resolveFns(buildJobSheetDocDef({ ...data, brand: null }))).toEqual(absent);
    expect(resolveFns(buildJobSheetDocDef({ ...data, brand: undefined }))).toEqual(absent);
  });

  it("the no-brand sheet IS today's: default identity pinned through the footer closure", () => {
    const flat = flatten(buildJobSheetDocDef(data));
    expect(flat).toContain("#C03838");
    expect(flat).toContain("Marley Moves · 01747 637070 · hello@marleymoves.co.uk");
  });

  it("a non-default brand substitutes identity + tints and includes the group line; zero default residue", () => {
    const flat = flatten(buildJobSheetDocDef({ ...data, brand: pitmans }));
    expect(flat).toContain(pitmans.name.toUpperCase());
    expect(flat).toContain(pitmans.groupLine);
    expect(flat).toContain(pitmans.colour);
    expect(flat).toContain(tintTowardsWhite(pitmans.colour, 0.94)); // soft fill
    expect(flat).toContain(tintTowardsWhite(pitmans.colour, 0.81)); // on-charcoal subtext
    expect(flat).toContain(`${pitmans.name} · ${pitmans.phone} · ${pitmans.email}`); // footer closure
    expect(flat).not.toContain("#C03838");
    expect(flat).not.toContain("01747 637070");
    expect(residue(flat, pitmans)).not.toContain("Marley");
  });
});

// ── 3 + 4: the GROUP doc-defs ──────────────────────────────────────────────

/** Compile-time probe: `true` only when T declares a `brand` key. Assigning
 *  `false` below stops type-checking the moment anyone adds one — the
 *  group/JOB split of PRD §3.6 cannot erode without failing `tsc --noEmit`. */
type HasBrand<T> = "brand" extends keyof T ? true : false;

const day = (): CrewDaySheet => ({
  crew: { id: "s1", fullName: "Rob Pierce", email: "rob@x.com", phone: "07700900123" },
  workDate: "2026-08-26",
  jobs: [
    {
      appointmentId: "a1",
      apptType: "removal",
      window: "09:00–13:00",
      startsAt: "2026-08-26T08:00:00Z",
      surveyId: null,
      sheet: {
        quoteRef: "PMR001",
        customerName: "Jane Doe",
        customerPhone: "07711 111111",
        moveDate: "2026-08-26",
        timeWindow: "09:00–13:00",
        days: 1,
        from: { address: "1 A St", postcode: "SP7 8AA", propertyType: "house", floor: "ground", lift: "no", accessM: 0 },
        to: { address: "2 B St", postcode: "BH1 1BB", propertyType: "flat", floor: "2", lift: "yes", accessM: 20 },
        vehicleLabel: "1 Luton Van",
        packingLabel: "Owner packs",
        crew: ["Rob Pierce"],
        vehicles: ["Luton 1 (AB12 CDE)"],
        items: [],
        accessNotes: "",
        largeItemsNotes: "",
        jobNotes: "",
        contractSigned: true,
      },
      brandShort: "Pitmans",
    },
  ],
});
const meta: DaySheetMeta = { version: 1, supersedes: false, generatedAtLabel: "x" };

describe("gate-14 spec — GROUP doc-defs take no brand parameter", () => {
  it("the day sheet's and statement's data shapes declare NO brand key (compile-level)", () => {
    const daySheetHasBrand: HasBrand<CrewDaySheet> = false;
    const daySheetMetaHasBrand: HasBrand<DaySheetMeta> = false;
    const statementHasBrand: HasBrand<StatementPdfData> = false;
    expect(daySheetHasBrand).toBe(false);
    expect(daySheetMetaHasBrand).toBe(false);
    expect(statementHasBrand).toBe(false);
    // And no third parameter has appeared to smuggle one in.
    expect(buildDaySheetDocDef.length).toBe(2);
    expect(buildStatementDocDef.length).toBe(1);
  });

  it("an all-second-brand day is SINGLE-brand: marker-free (unmarked ≠ default brand)", () => {
    const d = day();
    const second = day().jobs[0];
    second.appointmentId = "a2";
    second.sheet = { ...second.sheet, quoteRef: "PMR002" };
    d.jobs.push(second); // both jobs Pitmans
    const flat = JSON.stringify(buildDaySheetDocDef(d, meta));
    expect(flat).toContain("PMR001");
    expect(flat).not.toContain("· Pitmans");
  });

  it("a mixed day marks EVERY job's meta line with its brand short name", () => {
    const d = day();
    const second = day().jobs[0];
    second.appointmentId = "a2";
    second.sheet = { ...second.sheet, quoteRef: "MMR002" };
    second.brandShort = "Marley";
    d.jobs.push(second);
    const flat = JSON.stringify(buildDaySheetDocDef(d, meta));
    expect(flat).toContain("PMR001 · Pitmans");
    expect(flat).toContain("MMR002 · Marley");
  });
});
