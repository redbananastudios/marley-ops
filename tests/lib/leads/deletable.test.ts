import { describe, expect, it } from "vitest";

import {
  canDeleteLead,
  storageLetsBlockingDelete,
  type LeadDeletionFacts,
} from "@/lib/leads/deletable";

/**
 * Delete has no undo, so these tests are the guard. The failure they exist to
 * prevent is deleting a lead that carries business history — the trail behind
 * an invoice, a signed contract or a job in the diary.
 */
const clean: LeadDeletionFacts = {
  quotes: 0,
  appointments: 0,
  signatures: 0,
  cardPayments: 0,
  cubicSurveys: 0,
  orphanedStorageLets: 0,
  claims: 0,
  jobCompletions: 0,
};

describe("canDeleteLead", () => {
  it("allows a bare duplicate — nothing attached", () => {
    expect(canDeleteLead(clean)).toEqual({ deletable: true });
  });

  it.each([
    ["cardPayments", "a card payment has been taken against it"],
    ["signatures", "the customer has signed a document on it"],
    ["claims", "it has a claim against it"],
    ["jobCompletions", "the job has been completed"],
    ["orphanedStorageLets", "it is the last enquiry behind a storage let"],
    ["appointments", "it is in the diary"],
    ["quotes", "it has a quote"],
    ["cubicSurveys", "it has a survey"],
  ] as const)("refuses when %s exists, and says why", (field, reason) => {
    const verdict = canDeleteLead({ ...clean, [field]: 1 });
    expect(verdict).toEqual({ deletable: false, reason });
  });

  it("names the most consequential reason when several apply", () => {
    // Money first: the office should hear "a payment was taken", not "a quote".
    const verdict = canDeleteLead({ ...clean, quotes: 3, appointments: 1, cardPayments: 1 });
    expect(verdict).toEqual({
      deletable: false,
      reason: "a card payment has been taken against it",
    });
  });
});

/**
 * QA-20260820-08. The old guard counted `storage_lets` by `lead_id`, a column
 * no code path in the app ever writes — so for every real storage let the count
 * was 0 and the refusal was dead code. These pin the replacement policy, which
 * is deliberately NOT "the same count keyed on client_id": the let itself always
 * survives a lead delete (`client_id` is NOT NULL, the client is not deleted),
 * so what is being protected is the ENQUIRY behind it, and a surviving sibling
 * already preserves that.
 */
describe("storageLetsBlockingDelete", () => {
  it("blocks the last lead on a client that has storage business", () => {
    expect(
      storageLetsBlockingDelete({ clientId: "c1", siblingLeadCount: 0, letsOnClient: 1 }),
    ).toBe(1);
  });

  it("lets a duplicate go when a sibling lead keeps the trail", () => {
    // The whole point of delete is clearing duplicates. One of several leads on
    // a client must not become undeletable because a SIBLING has storage.
    expect(
      storageLetsBlockingDelete({ clientId: "c1", siblingLeadCount: 1, letsOnClient: 3 }),
    ).toBe(0);
  });

  it("does not block when the client has no storage at all", () => {
    expect(
      storageLetsBlockingDelete({ clientId: "c1", siblingLeadCount: 0, letsOnClient: 0 }),
    ).toBe(0);
  });

  it("does not block a lead with no client — there is nothing to orphan", () => {
    expect(
      storageLetsBlockingDelete({ clientId: null, siblingLeadCount: 0, letsOnClient: 9 }),
    ).toBe(0);
  });

  it("feeds canDeleteLead, so a stranded let is a refusal end to end", () => {
    const orphanedStorageLets = storageLetsBlockingDelete({
      clientId: "c1",
      siblingLeadCount: 0,
      letsOnClient: 2,
    });
    expect(canDeleteLead({ ...clean, orphanedStorageLets })).toEqual({
      deletable: false,
      reason: "it is the last enquiry behind a storage let",
    });
  });
});
