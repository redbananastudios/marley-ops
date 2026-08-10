import { describe, it, expect } from "vitest";
import { followUpLabel } from "@/lib/follow-ups/labels";

describe("followUpLabel", () => {
  it("names each of the five things that used to read 'Follow-up'", () => {
    // All share reason='custom', so the queue showed one identical grey chip for
    // a waiting customer, a dead address, a money ladder, a crew problem and an
    // accounting job.
    expect(followUpLabel("custom", "inbound_reply").label).toBe("Customer replied");
    expect(followUpLabel("custom", "email_bounced").label).toBe("Bounced email");
    expect(followUpLabel("custom", "commitment_chase").label).toBe("Commitment");
    expect(followUpLabel("custom", "sign_off_exception").label).toBe("Crew issue");
    expect(followUpLabel("custom", "card_payment").label).toBe("Credit note");
  });

  it("leaves the four self-describing reasons alone", () => {
    expect(followUpLabel("no_answer", "manual").label).toBe("No answer");
    expect(followUpLabel("deposit", "online_accept").label).toBe("Deposit");
    expect(followUpLabel("quote_followup", "survey_completed").label).toBe("Quote follow-up");
  });

  it("does NOT relabel a balance chase by its source", () => {
    // post_move_overdue is a balance chase. Renaming it would lose the money
    // signal the colour and rank carry.
    const l = followUpLabel("balance", "post_move_overdue");
    expect(l.label).toBe("Balance");
    expect(l.cls).toContain("warn");
  });

  it("falls back to the generic chip for an unknown source rather than rendering blank", () => {
    // `source` is free text with no CHECK constraint, so a new value can appear
    // at any time without a migration.
    const l = followUpLabel("custom", "something_new_next_month");
    expect(l.label).toBe("Follow-up");
    expect(l.cls).toBeTruthy();
  });

  it("survives nulls from the database", () => {
    expect(followUpLabel(null, null).label).toBe("Follow-up");
    expect(followUpLabel("custom", null).label).toBe("Follow-up");
  });

  it("ranks a waiting customer and a dead address above back-office jobs", () => {
    const reply = followUpLabel("custom", "inbound_reply").rank;
    const bounce = followUpLabel("custom", "email_bounced").rank;
    const creditNote = followUpLabel("custom", "card_payment").rank;
    const generic = followUpLabel("custom", null).rank;
    expect(reply).toBeLessThan(creditNote);
    expect(bounce).toBeLessThan(creditNote);
    expect(creditNote).toBeLessThan(generic);
  });
});
