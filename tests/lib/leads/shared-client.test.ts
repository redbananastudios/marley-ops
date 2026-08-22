import { describe, expect, it } from "vitest";

import { clientWriteThrough, leadContact } from "@/lib/leads/shared-client";

/**
 * QA-20260819-01. Dedup attaches several enquiries to one `clients` row, so a
 * lead page has two candidate sources for "the customer". Reading the client
 * first meant a lead's Contact card showed a DIFFERENT customer's details than
 * its own header, and saving one lead republished its details as every
 * sibling's. These pin both halves: which source wins on the page, and when the
 * shared row may be written.
 */
const lead = {
  name: "Janet Jones",
  phone: "07700900111",
  email: "janet@example.com",
  from_postcode: "BH1 1AA",
};

const sharedClient = {
  display_name: "Someone Else",
  phone_raw: "07700900999",
  phone_e164: "+447700900999",
  email: "someone.else@example.com",
  postcode_home: "SO41 0UE",
};

describe("leadContact", () => {
  it("shows the lead's OWN details, never a sibling's", () => {
    expect(leadContact(lead, sharedClient)).toEqual({
      name: "Janet Jones",
      phone: "07700900111",
      email: "janet@example.com",
      postcode: "BH1 1AA",
    });
  });

  it("falls back to the client only for a field the lead never captured", () => {
    // A fallback fills a blank; it cannot contradict a value shown elsewhere on
    // the page, which is what made the original precedence unsafe.
    const sparse = { name: "Janet Jones", phone: null, email: null, from_postcode: null };
    expect(leadContact(sparse, sharedClient)).toEqual({
      name: "Janet Jones",
      phone: "07700900999",
      email: "someone.else@example.com",
      postcode: "SO41 0UE",
    });
  });

  it("prefers the client's raw phone over the e164 form when filling a gap", () => {
    const sparse = { name: null, phone: null, email: null, from_postcode: null };
    expect(leadContact(sparse, { ...sharedClient, phone_raw: null }).phone).toBe("+447700900999");
  });

  it("copes with a lead that has no client at all", () => {
    expect(leadContact(lead, null)).toEqual({
      name: "Janet Jones",
      phone: "07700900111",
      email: "janet@example.com",
      postcode: "BH1 1AA",
    });
  });
});

describe("clientWriteThrough", () => {
  it("writes through when this is the only enquiry on the client", () => {
    // The point of the write: correcting a bounced address fixes the customer
    // record too. Right whenever there is nobody else to affect.
    expect(clientWriteThrough({ clientId: "c1", otherLeadCount: 0 })).toEqual({
      write: true,
      warning: null,
    });
  });

  it("declines — and says so — when siblings share the customer", () => {
    const r = clientWriteThrough({ clientId: "c1", otherLeadCount: 2 });
    expect(r.write).toBe(false);
    expect(r.warning).toContain("2 other enquiries share this customer");
    expect(r.warning).toContain("left unchanged");
  });

  it("uses the singular for exactly one sibling", () => {
    expect(clientWriteThrough({ clientId: "c1", otherLeadCount: 1 }).warning).toContain(
      "1 other enquiry shares this customer",
    );
  });

  it("treats a FAILED check as not-done, never as nothing-to-do", () => {
    // `clients.email` is a live sending surface (storage invoices). An office
    // that corrected an address must not be told it saved cleanly when we could
    // not establish whether the shared row was safe to touch.
    const r = clientWriteThrough({ clientId: "c1", otherLeadCount: null });
    expect(r.write).toBe(false);
    expect(r.warning).toContain("couldn't check");
  });

  it("is silent when there is no client — nothing was skipped", () => {
    expect(clientWriteThrough({ clientId: null, otherLeadCount: null })).toEqual({
      write: false,
      warning: null,
    });
  });
});
