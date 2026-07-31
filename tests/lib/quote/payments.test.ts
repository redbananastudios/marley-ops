import { describe, expect, it } from "vitest";
import {
  acceptExpiresAt,
  balanceDue,
  balanceDueDate,
  balanceReference,
  depositReference,
  isAcceptExpired,
  moveDateLabel,
  round2,
} from "@/lib/quote/payments";

/**
 * Money + reference rules for the two-invoice pattern. Load-bearing invariant:
 * deposit invoice + balance invoice must sum EXACTLY to the agreed price, and
 * the two Zoho reference numbers must never collide (idempotent adoption).
 */

describe("balanceDue", () => {
  it("agreed minus deposit", () => {
    expect(balanceDue(1440, 100)).toBe(1340);
  });

  it("deposit + balance always reconstruct the agreed price (pennies included)", () => {
    for (const agreed of [636, 1227.5, 1440.01, 3239.99, 100.01]) {
      const due = balanceDue(agreed, 100);
      expect(round2(due + 100)).toBe(round2(agreed));
    }
  });

  it("never negative — a deposit above the agreed price clamps to zero", () => {
    expect(balanceDue(80, 100)).toBe(0);
  });

  it("handles float artefacts at 2dp", () => {
    expect(balanceDue(100.1 + 0.2, 100)).toBe(0.3);
  });
});

describe("balance fallback carves out the raised 25% commitment (Payments Policy v2)", () => {
  // Pins the /bookings pre-invoice fallback: before the -BAL invoice exists,
  // the displayed "Balance outstanding" must equal what createBalanceInvoiceFlow
  // will raise — agreed − deposit − commitment (computeBalanceCredits) — not the
  // naive agreed − deposit, which double-counts the commitment. The page expresses
  // this as balanceDue(agreed, deposit + commitmentCredit).
  it("worked example: £2000 gross, £100 deposit, £400 commitment → £1500 balance", () => {
    const agreed = 2000;
    const deposit = 100;
    const commitment = 0.25 * agreed - deposit; // 400
    expect(commitment).toBe(400);
    expect(balanceDue(agreed, deposit + commitment)).toBe(1500);
    // and NOT the pre-fix figure that folded the commitment back in
    expect(balanceDue(agreed, deposit)).toBe(1900);
  });

  it("deposit + commitment + balance reconstruct the agreed price", () => {
    for (const agreed of [636, 1227.5, 1440.01, 3239.99, 2000]) {
      const deposit = 100;
      const commitment = round2(Math.max(0, 0.25 * agreed - deposit));
      const balance = balanceDue(agreed, deposit + commitment);
      expect(round2(deposit + commitment + balance)).toBe(round2(agreed));
    }
  });

  it("zero commitment (deposit ≥ 25% of gross) leaves the balance = agreed − deposit", () => {
    // Gross £360, deposit £100: 25%×360 = £90 ≤ £100, so no commitment is raised
    // (commitment_invoice_amount stays 0) and the fallback is unchanged.
    expect(balanceDue(360, 100 + 0)).toBe(260);
  });
});

describe("Zoho references", () => {
  it("deposit and balance references are distinct and quote-derived", () => {
    expect(depositReference("MM-260709-001")).toBe("MM-260709-001-DEP");
    expect(balanceReference("MM-260709-001")).toBe("MM-260709-001-BAL");
    expect(depositReference("X")).not.toBe(balanceReference("X"));
  });
});

describe("accept expiry (30-day quote validity)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const created = new Date("2026-06-01T10:00:00Z").toISOString();

  it("measures from the email send when present", () => {
    const sent = new Date("2026-06-10T10:00:00Z").toISOString();
    expect(acceptExpiresAt(sent, created).getTime()).toBe(new Date(sent).getTime() + 30 * DAY);
  });

  it("falls back to creation when never emailed", () => {
    expect(acceptExpiresAt(null, created).getTime()).toBe(new Date(created).getTime() + 30 * DAY);
  });

  it("29 days is live, 31 days is expired", () => {
    const sent = new Date("2026-06-01T10:00:00Z").toISOString();
    expect(isAcceptExpired(sent, created, new Date(new Date(sent).getTime() + 29 * DAY))).toBe(false);
    expect(isAcceptExpired(sent, created, new Date(new Date(sent).getTime() + 31 * DAY))).toBe(true);
  });
});

describe("balanceDueDate (chase = day before the move)", () => {
  const today = new Date("2026-07-09T12:00:00Z");

  it("day before a future move", () => {
    expect(balanceDueDate("2026-07-20", today)).toBe("2026-07-19");
  });

  it("move tomorrow → day-before is already past noon today → fallback window", () => {
    expect(balanceDueDate("2026-07-10", today)).toBe("2026-07-12");
  });

  it("no / bad / past move date → fallback days from today", () => {
    expect(balanceDueDate(null, today)).toBe("2026-07-12");
    expect(balanceDueDate("soon", today)).toBe("2026-07-12");
    expect(balanceDueDate("2026-07-01", today)).toBe("2026-07-12");
  });
});

describe("moveDateLabel", () => {
  it("formats the stored yyyy-mm-dd for customers", () => {
    expect(moveDateLabel("2026-07-20")).toBe("Monday 20 July");
  });
  it("null/garbage → null", () => {
    expect(moveDateLabel(null)).toBeNull();
    expect(moveDateLabel("not-a-date")).toBeNull();
  });
});
