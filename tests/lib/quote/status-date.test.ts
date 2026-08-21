import { describe, it, expect } from "vitest";
import { quoteStatusDate, type QuoteStatusDates } from "@/lib/quote/status-date";

// The QA-20260821-02 fixture: created 21 Aug, accepted 20 Aug — the card read
// "Accepted · 21 Aug 2026", pairing the status word with the wrong event.
const q = (over: Partial<QuoteStatusDates>): QuoteStatusDates => ({
  status: "accepted",
  created_at: "2026-08-21T00:12:00Z",
  email_sent_at: "2026-08-19T09:00:00Z",
  accepted_at: "2026-08-20T09:00:00Z",
  declined_at: null,
  ...over,
});

describe("quoteStatusDate", () => {
  it("pairs Accepted with accepted_at, not created_at (QA-20260821-02)", () => {
    expect(quoteStatusDate(q({}))).toBe("2026-08-20T09:00:00Z");
  });

  it("pairs Rejected with declined_at", () => {
    expect(quoteStatusDate(q({ status: "rejected", declined_at: "2026-08-22T10:00:00Z" }))).toBe(
      "2026-08-22T10:00:00Z",
    );
  });

  it("pairs Sent with email_sent_at", () => {
    expect(quoteStatusDate(q({ status: "sent" }))).toBe("2026-08-19T09:00:00Z");
  });

  it("shows a superseded quote's send date — the last event the row records", () => {
    expect(quoteStatusDate(q({ status: "superseded" }))).toBe("2026-08-19T09:00:00Z");
  });

  it("shows created_at for a draft — creation IS its only event", () => {
    expect(quoteStatusDate(q({ status: "draft" }))).toBe("2026-08-21T00:12:00Z");
  });

  it("falls back to created_at when the status timestamp is missing", () => {
    expect(quoteStatusDate(q({ accepted_at: null }))).toBe("2026-08-21T00:12:00Z");
    expect(quoteStatusDate(q({ status: "rejected" }))).toBe("2026-08-21T00:12:00Z");
    expect(quoteStatusDate(q({ status: "sent", email_sent_at: null }))).toBe("2026-08-21T00:12:00Z");
  });

  it("never invents a date for an unknown status", () => {
    expect(quoteStatusDate(q({ status: "something_new" }))).toBe("2026-08-21T00:12:00Z");
  });
});
