import { describe, expect, it } from "vitest";
import { oversizedTemplateVars, RESEND_TEMPLATE_VAR_LIMIT } from "@/lib/comms/send";

/**
 * Resend rejects any template variable value over 2,000 characters — and the
 * rejection kills the whole send, not just the variable (2026-08-05: Brydee's
 * "Move date confirmed" carried a 3,683-char COMMITMENT_BLOCK and failed 8
 * times; the retry worker re-drives the identical stored payload, so it could
 * never recover). dispatchComm uses this detector to fall back to the in-repo
 * bodyHtml instead of the managed template.
 */
describe("oversizedTemplateVars (Resend 2,000-char per-value limit)", () => {
  it("flags exactly the variables over the limit", () => {
    const vars = {
      QUOTE_REF: "MMR034",
      DEPOSIT_AMOUNT: "£100",
      COMMITMENT_BLOCK: "x".repeat(3683),
      HELD_POSITION_LINE: "y".repeat(231),
    };
    expect(oversizedTemplateVars(vars)).toEqual(["COMMITMENT_BLOCK"]);
  });

  it("the limit is a strict greater-than: exactly 2,000 chars still fits", () => {
    expect(oversizedTemplateVars({ A: "z".repeat(RESEND_TEMPLATE_VAR_LIMIT) })).toEqual([]);
    expect(oversizedTemplateVars({ A: "z".repeat(RESEND_TEMPLATE_VAR_LIMIT + 1) })).toEqual(["A"]);
  });

  it("numbers are measured as their string form; empty/missing vars pass", () => {
    expect(oversizedTemplateVars({ N: 1250 })).toEqual([]);
    expect(oversizedTemplateVars({})).toEqual([]);
    expect(oversizedTemplateVars(undefined)).toEqual([]);
  });
});
