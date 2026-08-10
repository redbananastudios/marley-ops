import { describe, it, expect } from "vitest";
import {
  planFollowUpClosures,
  type OpenFollowUp,
  type LeadState,
  type QuoteState,
} from "@/lib/follow-ups/reconcile";

const fu = (o: Partial<OpenFollowUp> & { id: string }): OpenFollowUp => ({
  lead_id: "L",
  quote_id: null,
  reason: "custom",
  source: "inbound_reply",
  ...o,
});
const lead = (status: string, id = "L", emailInvalidAt: string | null = null): LeadState => ({
  id,
  status,
  email_invalid_at: emailInvalidAt,
});
const quote = (o: Partial<QuoteState> & { id: string }): QuoteState => ({
  lead_id: "L",
  status: "sent",
  email_sent_at: "2026-08-06T10:00:00Z",
  ...o,
});

const ids = (c: { id: string }[]) => c.map((x) => x.id);

describe("planFollowUpClosures", () => {
  it("closes a reply task on a lead that has already been won", () => {
    // Corinna Booth: replied 5 Aug, task opened, quote since ACCEPTED — the job
    // is booked and the task sat 2 days overdue telling someone to respond.
    const c = planFollowUpClosures(
      [fu({ id: "f1", quote_id: "q1" })],
      [lead("confirmed")],
      [quote({ id: "q1", status: "accepted" })],
    );
    expect(ids(c)).toEqual(["f1"]);
    expect(c[0].why).toContain("confirmed");
  });

  it("closes 'build and send the quote' once a quote has gone out", () => {
    // Alina: quoted 6 Aug, but the close-on-send rule only landed 7 Aug.
    const c = planFollowUpClosures(
      [fu({ id: "f1", reason: "quote_followup", source: "survey_completed" })],
      [lead("quoted")],
      [quote({ id: "q1" })],
    );
    expect(c[0].why).toContain("quote has been sent");
  });

  it("closes a reply task once its quote is superseded", () => {
    // Shara Swan: replied about the wrong postcode, answered with a new quote.
    const c = planFollowUpClosures(
      [fu({ id: "f1", quote_id: "q1" })],
      [lead("quoted")],
      [quote({ id: "q1", status: "superseded" })],
    );
    expect(ids(c)).toEqual(["f1"]);
  });

  it("KEEPS a reply task whose quote is still live and unanswered", () => {
    // Julia Bradshaw: MMR031 still sent, lead still quoted — genuine work.
    const c = planFollowUpClosures(
      [fu({ id: "f1", quote_id: "q1" })],
      [lead("quoted")],
      [quote({ id: "q1", status: "sent" })],
    );
    expect(c).toEqual([]);
  });

  it("KEEPS a manual no-answer callback — that is a human's own reminder", () => {
    const c = planFollowUpClosures(
      [fu({ id: "f1", reason: "no_answer", source: "manual" })],
      [lead("website_enquiry")],
      [],
    );
    expect(c).toEqual([]);
  });

  it("NEVER closes a balance or deposit chase on a confirmed lead", () => {
    // These live ON confirmed leads by design. Closing them "because the lead is
    // settled" would silence the money ladder on every booked job.
    const c = planFollowUpClosures(
      [fu({ id: "bal", reason: "balance", source: "post_move_overdue" }), fu({ id: "dep", reason: "deposit", source: "chase_engine" })],
      [lead("confirmed")],
      [quote({ id: "q1", status: "accepted" })],
    );
    expect(c).toEqual([]);
  });

  it("closes a survey_completed task on a lead that went on to decline", () => {
    const c = planFollowUpClosures(
      [fu({ id: "f1", reason: "quote_followup", source: "survey_completed" })],
      [lead("declined")],
      [],
    );
    expect(c[0].why).toContain("declined");
  });

  it("leaves a survey_completed task open when no quote has been sent yet", () => {
    const c = planFollowUpClosures(
      [fu({ id: "f1", reason: "quote_followup", source: "survey_completed" })],
      [lead("survey_booked")],
      [quote({ id: "q1", status: "draft", email_sent_at: null })],
    );
    expect(c).toEqual([]);
  });

  it("ignores a task with no lead rather than throwing", () => {
    expect(planFollowUpClosures([fu({ id: "f1", lead_id: null })], [], [])).toEqual([]);
  });

  describe("bounced email", () => {
    const bounce = { id: "b1", lead_id: "L", quote_id: null, reason: "custom", source: "email_bounced" };

    it("closes once the address has been corrected", () => {
      const c = planFollowUpClosures([bounce], [lead("quoted", "L", null)], []);
      expect(c[0].why).toContain("corrected");
    });

    it("KEEPS it while the address is still marked bad", () => {
      const c = planFollowUpClosures([bounce], [lead("quoted", "L", "2026-08-09T10:00:00Z")], []);
      expect(c).toEqual([]);
    });

    it("KEEPS it on a confirmed booking with a still-broken address", () => {
      // The settled-lead rule must not swallow this: a customer whose email
      // bounces on a job we are about to do is exactly who we must reach.
      const c = planFollowUpClosures([bounce], [lead("confirmed", "L", "2026-08-09T10:00:00Z")], []);
      expect(c).toEqual([]);
    });

    it("does not close on a lead it knows nothing about", () => {
      expect(planFollowUpClosures([bounce], [], [])).toEqual([]);
    });
  });

  it("NEVER auto-closes a credit-note task — that is real accounting work", () => {
    const creditNote = {
      id: "cn",
      lead_id: "L",
      quote_id: null,
      reason: "custom",
      source: "card_payment",
      metadata: { kind: "credit_note" },
    };
    expect(planFollowUpClosures([creditNote], [lead("completed")], [])).toEqual([]);
  });
});
