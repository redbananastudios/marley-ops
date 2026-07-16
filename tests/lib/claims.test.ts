import { describe, expect, it } from "vitest";
import {
  CLAIM_CHANNEL_LABEL,
  CLAIM_CHANNELS,
  CLAIM_RESOLUTION_LABEL,
  CLAIM_RESOLUTIONS,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUSES,
  claimRef,
  daysOpen,
  isClaimResolution,
  isClaimStatus,
  isOpenClaimStatus,
  MANUAL_CLAIM_CHANNELS,
  reportWindowEnd,
  validateClaimUpdate,
} from "@/lib/claims";

describe("claim vocabulary", () => {
  it("every status/resolution/channel has a label (UI never renders a raw key)", () => {
    for (const s of CLAIM_STATUSES) expect(CLAIM_STATUS_LABEL[s]).toBeTruthy();
    for (const r of CLAIM_RESOLUTIONS) expect(CLAIM_RESOLUTION_LABEL[r]).toBeTruthy();
    for (const c of CLAIM_CHANNELS) expect(CLAIM_CHANNEL_LABEL[c]).toBeTruthy();
  });

  it("open set = the three live statuses; guards reject junk", () => {
    expect(isOpenClaimStatus("open")).toBe(true);
    expect(isOpenClaimStatus("assessing")).toBe(true);
    expect(isOpenClaimStatus("offer_made")).toBe(true);
    expect(isOpenClaimStatus("settled")).toBe(false);
    expect(isOpenClaimStatus("banana")).toBe(false);
    expect(isClaimStatus("rejected")).toBe(true);
    expect(isClaimStatus("REJECTED")).toBe(false);
    expect(isClaimResolution("repair")).toBe(true);
    expect(isClaimResolution(null)).toBe(false);
  });

  it("manual channels exclude the reserved sign_off", () => {
    expect(MANUAL_CLAIM_CHANNELS).not.toContain("sign_off");
    for (const c of MANUAL_CLAIM_CHANNELS) expect(CLAIM_CHANNELS).toContain(c);
  });

  it("claimRef pads to three digits and keeps growing", () => {
    expect(claimRef(1)).toBe("CLM-001");
    expect(claimRef(42)).toBe("CLM-042");
    expect(claimRef(1234)).toBe("CLM-1234");
  });
});

describe("validateClaimUpdate", () => {
  it("live statuses clear resolution + amount (reopen path)", () => {
    const v = validateClaimUpdate({ status: "assessing", resolution: "repair", resolutionAmount: 50 });
    expect(v).toEqual({ ok: true, terminal: false, resolution: null, resolutionAmount: null });
  });

  it("terminal without a resolution is refused", () => {
    const v = validateClaimUpdate({ status: "settled", resolution: null, resolutionAmount: null });
    expect(v.ok).toBe(false);
  });

  it("goodwill payment requires a positive amount", () => {
    expect(
      validateClaimUpdate({ status: "settled", resolution: "goodwill_payment", resolutionAmount: null }).ok,
    ).toBe(false);
    expect(
      validateClaimUpdate({ status: "settled", resolution: "goodwill_payment", resolutionAmount: 0 }).ok,
    ).toBe(false);
    const ok = validateClaimUpdate({ status: "settled", resolution: "goodwill_payment", resolutionAmount: 120 });
    expect(ok).toEqual({ ok: true, terminal: true, resolution: "goodwill_payment", resolutionAmount: 120 });
  });

  it("other resolutions allow a missing amount but reject junk amounts", () => {
    expect(
      validateClaimUpdate({ status: "closed", resolution: "no_claim", resolutionAmount: null }).ok,
    ).toBe(true);
    expect(
      validateClaimUpdate({ status: "settled", resolution: "insurer_claim", resolutionAmount: -5 }).ok,
    ).toBe(false);
    expect(
      validateClaimUpdate({ status: "settled", resolution: "repair", resolutionAmount: Number.NaN }).ok,
    ).toBe(false);
    expect(
      validateClaimUpdate({ status: "settled", resolution: "repair", resolutionAmount: 2_000_000 }).ok,
    ).toBe(false);
  });
});

describe("date maths", () => {
  it("daysOpen floors whole days and never goes negative", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    expect(daysOpen("2026-07-16T09:00:00Z", now)).toBe(0);
    expect(daysOpen("2026-07-13T11:00:00Z", now)).toBe(3);
    expect(daysOpen("2026-07-17T00:00:00Z", now)).toBe(0); // clock skew guard
    expect(daysOpen("not-a-date", now)).toBe(0);
  });

  it("reportWindowEnd = completion + 7 days; null on junk", () => {
    expect(reportWindowEnd("2026-07-10T14:00:00Z")?.toISOString()).toBe("2026-07-17T14:00:00.000Z");
    expect(reportWindowEnd("junk")).toBeNull();
  });
});
