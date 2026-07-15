import { describe, expect, it } from "vitest";
import {
  PUSH_CATEGORIES,
  PUSH_CATEGORY_IDS,
  decideEnquiryPushes,
  ENQUIRY_DIGEST_THRESHOLD,
  firstNameOnly,
  isPushCategoryId,
  newEnquiryDigestPush,
  newEnquiryPush,
  paymentPush,
} from "@/lib/push/categories";
import { isAllowedPushRoute } from "@/lib/push/payload";

describe("push category registry", () => {
  it("declares only office audiences in v1 (crew never receive pushes)", () => {
    for (const id of PUSH_CATEGORY_IDS) {
      expect(PUSH_CATEGORIES[id].audience).toEqual(["admin", "estimator"]);
    }
  });

  it("only new_enquiry suppresses when the app is focused (the chime conflict rule)", () => {
    expect(PUSH_CATEGORIES.new_enquiry.suppressWhenFocused).toBe(true);
    expect(PUSH_CATEGORIES.payment_event.suppressWhenFocused).toBe(false);
  });

  it("validates category ids", () => {
    expect(isPushCategoryId("new_enquiry")).toBe(true);
    expect(isPushCategoryId("payment_event")).toBe(true);
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
