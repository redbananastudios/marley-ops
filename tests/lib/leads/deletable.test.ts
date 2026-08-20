import { describe, expect, it } from "vitest";

import { canDeleteLead, type LeadDeletionFacts } from "@/lib/leads/deletable";

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
  storageLets: 0,
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
    ["storageLets", "it has a storage let"],
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
