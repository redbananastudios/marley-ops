import { describe, expect, it } from "vitest";
import {
  buildEstimatorLines,
  commissionAmount,
  jobValueExVat,
  jobVatApplies,
  type CompletedJob,
  type EstimatorFees,
  type PhoneQuote,
  type SurveyVisit,
} from "@/lib/estimator/invoice";

const FEES: EstimatorFees = { surveyFee: 50, phoneQuoteFee: 10, commissionPct: 7.5 };

describe("jobValueExVat", () => {
  it("strips 20% VAT from a VAT-enabled (gross) value", () => {
    expect(jobValueExVat(1200, true)).toBe(1000); // 1200 / 1.2
    expect(jobValueExVat(2979.15, true)).toBe(2482.63); // real invoice gross → net
  });
  it("treats a pre-registration (vat disabled) value as already ex-VAT", () => {
    expect(jobValueExVat(1000, false)).toBe(1000);
  });
  it("never divides by the Flat Rate 1.10 — always the 20% the customer is charged", () => {
    // If it wrongly used /1.10, 1200 → 1090.91. It must be the 20% figure.
    expect(jobValueExVat(1200, true)).not.toBe(1090.91);
    expect(jobValueExVat(1200, true)).toBe(1000);
  });
  it("floors negatives/blanks at zero", () => {
    expect(jobValueExVat(-500, true)).toBe(0);
    expect(jobValueExVat(0, true)).toBe(0);
  });
});

describe("commissionAmount", () => {
  it("is pct% of the ex-VAT value", () => {
    expect(commissionAmount(1200, true, 7.5)).toBe(75); // ex-VAT 1000 × 7.5%
    expect(commissionAmount(1000, false, 7.5)).toBe(75); // already ex-VAT
    expect(commissionAmount(1200, true, 10)).toBe(100); // ex-VAT 1000 × 10%
  });
  it("rounds to the penny", () => {
    // ex-VAT 1666.67 × 7.5% = 125.000... ; 2000 gross → ex 1666.67 → 125.00
    expect(commissionAmount(2000, true, 7.5)).toBe(125);
  });
  it("is zero for a valueless or negative job", () => {
    expect(commissionAmount(0, true, 7.5)).toBe(0);
    expect(commissionAmount(-100, false, 7.5)).toBe(0);
  });
});

describe("jobVatApplies (VAT registration-date floor)", () => {
  // VAT_REGISTERED_FROM = "2026-06-01" (lib/finance/invoices).
  it("is false when the quote never had VAT, whatever the date", () => {
    expect(jobVatApplies(false, "2026-07-01")).toBe(false);
    expect(jobVatApplies(false, "2026-05-01")).toBe(false);
    expect(jobVatApplies(false, null)).toBe(false);
  });
  it("applies VAT for a VAT-enabled job billed on/after registration", () => {
    expect(jobVatApplies(true, "2026-06-01")).toBe(true);
    expect(jobVatApplies(true, "2026-07-16")).toBe(true);
  });
  it("floors VAT to none for a job billed BEFORE registration even if the flag says true", () => {
    // The stale-flag case the edge is about: a pre-registration completion must
    // not be divided by 1.2, or the estimator is under-paid.
    expect(jobVatApplies(true, "2026-05-31")).toBe(false);
    expect(jobVatApplies(true, "2026-01-15")).toBe(false);
  });
  it("treats a missing date as current-era (VAT applies)", () => {
    expect(jobVatApplies(true, null)).toBe(true);
  });
  it("end-to-end: a pre-registration job earns commission on the FULL value (no /1.2)", () => {
    const vat = jobVatApplies(true, "2026-05-20"); // pre-reg → false
    expect(commissionAmount(1200, vat, 7.5)).toBe(90); // 7.5% of 1200, not of 1000
  });
});

describe("buildEstimatorLines", () => {
  const survey = (apptId: string, customer: string, day: string): SurveyVisit => ({
    apptId,
    leadId: `lead-${apptId}`,
    customer,
    day,
  });
  const phone = (leadId: string, customer: string, day: string, ref: string | null = null): PhoneQuote => ({
    leadId,
    ref,
    customer,
    day,
  });
  const job = (leadId: string, customer: string, day: string, value: number, vatEnabled = true, ref: string | null = null): CompletedJob => ({
    leadId,
    ref,
    customer,
    day,
    value,
    vatEnabled,
  });

  it("prices each source and orders survey → phone → commission", () => {
    const lines = buildEstimatorLines({
      surveys: [survey("a1", "Smith", "2026-07-14")],
      phoneQuotes: [phone("l2", "Jones", "2026-07-15", "MMR002")],
      completions: [job("l3", "Brown", "2026-07-16", 1200, true, "MMR003")],
      fees: FEES,
    });
    expect(lines.map((l) => l.source)).toEqual(["survey", "phone_quote", "commission"]);
    expect(lines[0].amount).toBe(50);
    expect(lines[1].amount).toBe(10);
    expect(lines[2].amount).toBe(75); // 7.5% of ex-VAT 1000
    expect(lines[1].description).toContain("MMR002");
    expect(lines[2].description).toContain("MMR003");
    expect(lines[2].description).toContain("£1,000.00"); // ex-VAT base surfaced
  });

  it("is amount-only (no hours/rate) so the shared PDF never shows a bogus HOURS figure", () => {
    const lines = buildEstimatorLines({
      surveys: [survey("a1", "Smith", "2026-07-14")],
      phoneQuotes: [],
      completions: [],
      fees: FEES,
    });
    expect(lines[0].quantity).toBeNull();
    expect(lines[0].unit_amount).toBeNull();
  });

  it("charges the survey fee PER VISIT (deduped by appointment, not lead)", () => {
    const lines = buildEstimatorLines({
      surveys: [survey("a1", "Smith", "2026-07-14"), survey("a1", "Smith", "2026-07-14")],
      phoneQuotes: [],
      completions: [],
      fees: FEES,
    });
    expect(lines).toHaveLength(1); // same apptId collapses
  });

  it("charges one telephone fee per lead and one commission per completed job", () => {
    const lines = buildEstimatorLines({
      surveys: [],
      phoneQuotes: [phone("l2", "Jones", "2026-07-15"), phone("l2", "Jones", "2026-07-16")],
      completions: [job("l3", "Brown", "2026-07-16", 1200), job("l3", "Brown", "2026-07-16", 1200)],
      fees: FEES,
    });
    expect(lines.filter((l) => l.source === "phone_quote")).toHaveLength(1);
    expect(lines.filter((l) => l.source === "commission")).toHaveLength(1);
  });

  it("drops a commission line for a £0 job (nothing to bill)", () => {
    const lines = buildEstimatorLines({
      surveys: [],
      phoneQuotes: [],
      completions: [job("l3", "Brown", "2026-07-16", 0)],
      fees: FEES,
    });
    expect(lines).toHaveLength(0);
  });

  it("orders each block by day", () => {
    const lines = buildEstimatorLines({
      surveys: [survey("a2", "Later", "2026-07-18"), survey("a1", "Earlier", "2026-07-14")],
      phoneQuotes: [],
      completions: [],
      fees: FEES,
    });
    expect(lines[0].description).toContain("Earlier");
    expect(lines[1].description).toContain("Later");
  });

  it("carries the ledger keys so a fee is billed once ever: appointment on survey, lead on all", () => {
    const lines = buildEstimatorLines({
      surveys: [survey("a1", "Smith", "2026-07-14")],
      phoneQuotes: [phone("l2", "Jones", "2026-07-15")],
      completions: [job("l3", "Brown", "2026-07-16", 1200)],
      fees: FEES,
    });
    const s = lines.find((l) => l.source === "survey")!;
    expect(s.appointment_id).toBe("a1");
    expect(s.lead_id).toBe("lead-a1");
    const p = lines.find((l) => l.source === "phone_quote")!;
    expect(p.appointment_id).toBeNull();
    expect(p.lead_id).toBe("l2");
    const c = lines.find((l) => l.source === "commission")!;
    expect(c.appointment_id).toBeNull();
    expect(c.lead_id).toBe("l3");
  });

  it("formats a whole-number commission percentage without a trailing .0", () => {
    const lines = buildEstimatorLines({
      surveys: [],
      phoneQuotes: [],
      completions: [job("l3", "Brown", "2026-07-16", 1200)],
      fees: { ...FEES, commissionPct: 10 },
    });
    expect(lines[0].description).toContain("Commission 10% of");
  });
});
