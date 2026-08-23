import { describe, expect, it } from "vitest";
import {
  customerNoticeOutcome,
  customerNoticeLabel,
  type CustomerNotice,
} from "@/lib/refunds/customer-notice";

describe("customerNoticeOutcome", () => {
  it("reports a real send as sent", () => {
    expect(customerNoticeOutcome({ hasEmail: true, hasLines: true, dispatch: { ok: true } })).toBe("sent");
  });

  it("does not claim a fresh send when dispatchComm deduplicated it", () => {
    // The customer DOES have the email — but saying "emailed" implies we just
    // sent one, and the office may be re-pressing precisely because they think
    // the first never went.
    expect(customerNoticeOutcome({ hasEmail: true, hasLines: true, dispatch: { duplicate: true } })).toBe(
      "already_sent",
    );
  });

  it("reports a provider failure as failed, never as sent", () => {
    expect(
      customerNoticeOutcome({ hasEmail: true, hasLines: true, dispatch: { ok: false, error: "bounced" } }),
    ).toBe("failed");
  });

  it("reports a missing address as no_email — this is the QA-20260823-03 case", () => {
    expect(customerNoticeOutcome({ hasEmail: false, hasLines: true, dispatch: null })).toBe("no_email");
  });

  it("names the case where nobody was told anything at all", () => {
    // An email on file but no refund lines fell between the server's `if` and
    // `else if`: no customer email AND no ops alert. It must not read as sent.
    expect(customerNoticeOutcome({ hasEmail: true, hasLines: false, dispatch: null })).toBe("nothing_to_send");
  });

  it("a missing address outranks everything — we never claim a send without one", () => {
    expect(customerNoticeOutcome({ hasEmail: false, hasLines: false, dispatch: { ok: true } })).toBe("no_email");
  });
});

describe("customerNoticeLabel", () => {
  it("only the true-positive path may say the customer was emailed", () => {
    const claims = (n: CustomerNotice) => customerNoticeLabel(n, "Refund completed");
    expect(claims("sent")).toContain("customer emailed");
    for (const n of ["failed", "no_email", "nothing_to_send"] as const) {
      expect(claims(n), n).not.toMatch(/—\s*customer emailed\./);
    }
  });

  it("says plainly when the customer has NOT been told", () => {
    expect(customerNoticeLabel("no_email", "Refund completed")).toMatch(/NOT been told/);
    expect(customerNoticeLabel("failed", "Refund completed")).toMatch(/FAILED/);
  });

  it("an ABSENT notice makes no claim — it must not default to \"emailed\"", () => {
    // A path that returns no notice (or an older server) is exactly where a
    // default of "sent" would quietly rebuild the bug this removes.
    expect(customerNoticeLabel(undefined, "Refund completed")).toBe("Refund completed.");
    expect(customerNoticeLabel(undefined, "Refund completed")).not.toMatch(/emailed/);
  });

  it("carries the caller's verb so Complete and Retain read correctly", () => {
    expect(customerNoticeLabel("sent", "Outcome recorded")).toBe("Outcome recorded — customer emailed.");
  });
});
