import { describe, expect, it } from "vitest";
import {
  BANK_FEED_DIGEST_THRESHOLD,
  PUSH_CATEGORIES,
  bankPaymentPush,
  crewJobPush,
  decideBankFeedPushes,
  decideEnquiryPushes,
  ENQUIRY_DIGEST_THRESHOLD,
  firstNameOnly,
  isPushCategoryId,
  newEnquiryDigestPush,
  newEnquiryPush,
  paymentPush,
  ukJobDayLabel,
  type BankFeedArrival,
} from "@/lib/push/categories";
import { isAllowedPushRoute } from "@/lib/push/payload";

describe("push category registry", () => {
  it("office categories go to office; crew_job admits any role (targeted-only, incl. office logins working jobs)", () => {
    expect(PUSH_CATEGORIES.new_enquiry.audience).toEqual(["admin", "estimator"]);
    expect(PUSH_CATEGORIES.payment_event.audience).toEqual(["admin", "estimator"]);
    expect(PUSH_CATEGORIES.crew_job.audience).toEqual(["crew", "admin", "estimator"]);
  });

  it("only new_enquiry suppresses when the app is focused (the chime conflict rule)", () => {
    expect(PUSH_CATEGORIES.new_enquiry.suppressWhenFocused).toBe(true);
    expect(PUSH_CATEGORIES.payment_event.suppressWhenFocused).toBe(false);
    expect(PUSH_CATEGORIES.crew_job.suppressWhenFocused).toBe(false);
  });

  it("validates category ids", () => {
    expect(isPushCategoryId("new_enquiry")).toBe(true);
    expect(isPushCategoryId("payment_event")).toBe(true);
    expect(isPushCategoryId("crew_job")).toBe(true);
    expect(isPushCategoryId("marketing_blast")).toBe(false);
  });
});

describe("firstNameOnly", () => {
  it("takes the first name only and title-cases it", () => {
    expect(firstNameOnly("sarah jane smith")).toBe("Sarah");
    expect(firstNameOnly("  freddy   arbuthnot ")).toBe("Freddy");
  });

  it("falls back on empty/missing names", () => {
    expect(firstNameOnly(null)).toBe("A customer");
    expect(firstNameOnly("   ", "Someone")).toBe("Someone");
  });

  it("de-shouts bank-statement ALL-CAPS but leaves mixed case alone", () => {
    expect(firstNameOnly("JOHN DOE")).toBe("John");
    expect(firstNameOnly("McDonald")).toBe("McDonald");
  });
});

describe("copy builders", () => {
  it("new enquiry: first name only, deep link to the lead", () => {
    const e = newEnquiryPush({ id: "abc-123", name: "Sarah Smith" });
    expect(e.body).toBe("Sarah has asked for a quote.");
    expect(e.url).toBe("/leads/abc-123");
    expect(e.eventKey).toBe("enquiry-abc-123");
    expect(isAllowedPushRoute(e.url)).toBe(true);
  });

  it("payment: no amounts, no addresses — first name and kind only", () => {
    const e = paymentPush({ kind: "deposit", quoteId: "q1", customerName: "Freddy Arbuthnot", leadId: "l1" });
    expect(e.title).toBe("Deposit received");
    expect(e.body).toBe("Freddy has paid their deposit.");
    expect(e.body).not.toMatch(/£|\d/);
    expect(e.url).toBe("/leads/l1");
  });

  it("payment without a lead deep-links to bookings", () => {
    const e = paymentPush({ kind: "balance", quoteId: "q1", customerName: null, leadId: null });
    expect(e.url).toBe("/bookings");
    expect(e.body).toBe("A customer has paid their balance.");
  });

  it("digest copy carries the count", () => {
    expect(newEnquiryDigestPush(7).body).toBe("7 new website enquiries need review.");
  });
});

describe("bank-feed arrival pushes", () => {
  const arrival = (over: Partial<BankFeedArrival>): BankFeedArrival => ({
    rowId: "tx-row-1",
    outcome: "suggested",
    kind: "deposit",
    name: "Jane Smith",
    quoteRef: "MMR001",
    ...over,
  });

  it("suggested match: first name + ref, deep link to /payments, NO £ amount", () => {
    const e = bankPaymentPush(arrival({}));
    expect(e.category).toBe("payment_event");
    expect(e.title).toBe("Bank payment in");
    expect(e.body).toBe("Looks like Jane's deposit (MMR001) — one tap to confirm.");
    expect(e.body).not.toMatch(/£/);
    expect(e.url).toBe("/payments");
    expect(isAllowedPushRoute(e.url)).toBe(true);
  });

  it("one OS tag per transfer, so a later match REPLACES a 'needs matching' alert", () => {
    const first = bankPaymentPush(arrival({ outcome: "attention", kind: null, quoteRef: null }));
    const later = bankPaymentPush(arrival({}));
    expect(first.eventKey).toBe(later.eventKey);
    expect(first.eventKey).toBe("bank-tx-tx-row-1");
  });

  it("mismatch (right quote, wrong amount) reads as needs-a-look, never confirmable copy", () => {
    const e = bankPaymentPush(arrival({ outcome: "attention", kind: "balance" }));
    expect(e.body).toBe("A payment from Jane doesn't match what's due on MMR001 — needs a look.");
    expect(e.body).not.toMatch(/confirm/i);
  });

  it("plain unmatched transfer uses the payer's first name off the statement", () => {
    const e = bankPaymentPush(arrival({ outcome: "attention", kind: null, name: "JOHN DOE", quoteRef: null }));
    expect(e.body).toBe("A payment from John needs matching to a job.");
  });

  it("storage references get storage copy; a missing name reads naturally", () => {
    expect(bankPaymentPush(arrival({ kind: "storage", quoteRef: null })).body).toBe(
      "A storage payment has arrived — check it on Payments.",
    );
    expect(bankPaymentPush(arrival({ name: null, quoteRef: null })).body).toBe(
      "Looks like a customer's deposit — one tap to confirm.",
    );
  });

  it("a burst collapses into one digest; small batches notify individually", () => {
    const many = Array.from({ length: BANK_FEED_DIGEST_THRESHOLD + 1 }, (_, i) => arrival({ rowId: `r${i}` }));
    const digest = decideBankFeedPushes(many);
    expect(digest).toHaveLength(1);
    expect(digest[0].body).toBe(`${many.length} bank payments arrived and need checking.`);
    expect(digest[0].url).toBe("/payments");

    expect(decideBankFeedPushes(many.slice(0, 2))).toHaveLength(2);
    expect(decideBankFeedPushes([])).toEqual([]);
  });
});

describe("crewJobPush", () => {
  const base = { appointmentId: "appt-1", staffUserId: "user-1", startsAt: "2026-07-18T08:00:00Z" };

  it("assigned: day-only copy, deep link to the crew job page", () => {
    const e = crewJobPush({ ...base, kind: "assigned" });
    expect(e.title).toBe("New job for you");
    expect(e.body).toBe("You've been put on a job on Sat 18 Jul.");
    expect(e.url).toBe("/my-jobs/appt-1");
    expect(isAllowedPushRoute(e.url)).toBe(true);
  });

  it("removed: links to the job LIST (the job page would refuse them now)", () => {
    const e = crewJobPush({ ...base, kind: "removed" });
    expect(e.body).toBe("You've been taken off the job on Sat 18 Jul.");
    expect(e.url).toBe("/my-jobs");
  });

  it("assigned + removed share one tag so a removal replaces the stale alert", () => {
    const a = crewJobPush({ ...base, kind: "assigned" });
    const r = crewJobPush({ ...base, kind: "removed" });
    expect(a.eventKey).toBe(r.eventKey);
  });

  it("copy never leaks names, addresses or money", () => {
    const e = crewJobPush({ ...base, kind: "assigned" });
    expect(e.body).not.toMatch(/£/);
    expect(e.body).toMatch(/^You've been/);
  });

  it("copes with a missing date", () => {
    const e = crewJobPush({ ...base, startsAt: null, kind: "assigned" });
    expect(e.body).toBe("You've been put on a job.");
  });
});

describe("ukJobDayLabel", () => {
  it("formats in UK time (BST boundary: 23:30Z on the 17th is the 18th in London)", () => {
    expect(ukJobDayLabel("2026-07-17T23:30:00Z")).toBe("Sat 18 Jul");
  });

  it("null/garbage → null", () => {
    expect(ukJobDayLabel(null)).toBeNull();
    expect(ukJobDayLabel("nonsense")).toBeNull();
  });
});

describe("decideEnquiryPushes (storm guard)", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const fresh = (id: string, name: string) => ({ id, name, submittedAt: "2026-07-15T11:00:00Z" });

  it("stale leads (the cutover backfill) push NOTHING", () => {
    const old = [
      { id: "a", name: "Old One", submittedAt: "2026-05-01T10:00:00Z" },
      { id: "b", name: "Old Two", submittedAt: "2026-06-01T10:00:00Z" },
    ];
    expect(decideEnquiryPushes(old, now)).toEqual([]);
  });

  it("missing/garbage submittedAt is treated as stale, not fresh", () => {
    expect(decideEnquiryPushes([{ id: "a", name: "X", submittedAt: null }], now)).toEqual([]);
    expect(decideEnquiryPushes([{ id: "a", name: "X", submittedAt: "not-a-date" }], now)).toEqual([]);
  });

  it("1-3 fresh leads notify individually", () => {
    const events = decideEnquiryPushes([fresh("a", "Ann"), fresh("b", "Bob")], now);
    expect(events).toHaveLength(2);
    expect(events[0].url).toBe("/leads/a");
    expect(events[1].body).toBe("Bob has asked for a quote.");
  });

  it("more than the threshold collapses into one digest", () => {
    const many = Array.from({ length: ENQUIRY_DIGEST_THRESHOLD + 2 }, (_, i) => fresh(`id${i}`, `P${i}`));
    const events = decideEnquiryPushes(many, now);
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe(`${many.length} new website enquiries need review.`);
    expect(events[0].url).toBe("/leads");
  });

  it("mixes: only the fresh subset counts", () => {
    const mixed = [
      fresh("a", "Ann"),
      { id: "z", name: "Old", submittedAt: "2026-01-01T00:00:00Z" },
    ];
    const events = decideEnquiryPushes(mixed, now);
    expect(events).toHaveLength(1);
    expect(events[0].url).toBe("/leads/a");
  });
});
