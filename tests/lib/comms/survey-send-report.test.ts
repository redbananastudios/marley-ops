import { describe, it, expect } from "vitest";
import { reportSurveySend, duplicateWarning } from "@/lib/comms/survey-send-report";

describe("reportSurveySend", () => {
  it("groups the channels that genuinely left", () => {
    expect(reportSurveySend({ email: "sent", sms: "sent" }).sent).toBe("email + SMS");
    expect(reportSurveySend({ email: "sent", sms: "skipped" }).sent).toBe("email");
    expect(reportSurveySend({ email: "skipped", sms: "sent" }).sent).toBe("SMS");
  });

  it("never counts a duplicate-suppressed send as sent", () => {
    // The bug this exists to stop: moving a survey Thu→Fri→Thu→Fri makes the
    // third email byte-identical to the first, so the content-hash dedupe drops
    // it. The customer's latest email still says Thursday. Reporting that as
    // "sent" told the office the new time had gone out when it had not.
    const r = reportSurveySend({ email: "duplicate", sms: "sent" });
    expect(r.sent).toBe("SMS");
    expect(r.duplicate).toBe("email");
    expect(r.sent).not.toContain("email");
  });

  it("separates failures from duplicates — they need different actions", () => {
    const r = reportSurveySend({ email: "failed", sms: "duplicate" });
    expect(r.failed).toBe("email");
    expect(r.duplicate).toBe("SMS");
    expect(r.sent).toBeNull();
  });

  it("reports nothing at all when both channels were skipped", () => {
    const r = reportSurveySend({ email: "skipped", sms: "skipped" });
    expect(r).toEqual({ sent: null, failed: null, duplicate: null });
  });

  it("can report all three states at once", () => {
    const r = reportSurveySend({ email: "sent", sms: "failed" });
    expect(r.sent).toBe("email");
    expect(r.failed).toBe("SMS");
    expect(r.duplicate).toBeNull();
  });
});

describe("duplicateWarning", () => {
  it("tells the office the customer still holds the OLD message", () => {
    const w = duplicateWarning("email");
    expect(w).toContain("not sent again");
    expect(w).toContain("still has the earlier one");
    // It has to prompt an action — a suppressed notice is silent otherwise.
    expect(w.toLowerCase()).toContain("call them");
  });

  it("takes the noun so booking and reschedule read naturally", () => {
    expect(duplicateWarning("email", "confirmation")).toContain("The email confirmation");
    expect(duplicateWarning("SMS")).toContain("The SMS message");
  });
});
