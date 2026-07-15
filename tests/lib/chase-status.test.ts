import { describe, expect, it } from "vitest";
import { chaseStatusLine, type ChaseStatusLineArgs } from "@/lib/quote/chase-status";

// Quote emailed 10 Jul 10:00 UTC → chase days [2,5,10] scheduled 12 / 15 / 20 Jul.
const EMAIL_SENT = "2026-07-10T10:00:00Z";
// Accepted 14 Jul 10:00 UTC → deposit days [1,3] scheduled 15 / 17 Jul.
const ACCEPTED = "2026-07-14T10:00:00Z";

// A `now` before every scheduled send so "goes around" / "next around" wording shows.
const NOW_EARLY = new Date("2026-07-11T08:00:00Z");

const base = (o: Partial<ChaseStatusLineArgs> = {}): ChaseStatusLineArgs => ({
  leadStatus: "quoted",
  chasePaused: false,
  quoteStatus: "sent",
  emailSentAt: EMAIL_SENT,
  acceptedAt: null,
  quoteChaseStep: 0,
  depositChaseStep: 0,
  now: NOW_EARLY,
  ...o,
});

describe("chaseStatusLine — null (nothing to chase)", () => {
  it("returns null when the lead is a fresh new lead", () => {
    expect(chaseStatusLine(base({ leadStatus: "new" }))).toBeNull();
  });

  it("returns null once confirmed (accepted + deposit paid)", () => {
    expect(chaseStatusLine(base({ leadStatus: "confirmed" }))).toBeNull();
  });

  it("returns null when the job is completed", () => {
    expect(chaseStatusLine(base({ leadStatus: "completed" }))).toBeNull();
  });

  it("returns null when the lead is declined/lost", () => {
    expect(chaseStatusLine(base({ leadStatus: "declined" }))).toBeNull();
  });

  it("returns null on the quote page for an old superseded quote (not the driver)", () => {
    expect(chaseStatusLine(base({ leadStatus: "quoted", quoteStatus: "superseded" }))).toBeNull();
  });

  it("returns null when the quote was never actually emailed", () => {
    expect(chaseStatusLine(base({ emailSentAt: null }))).toBeNull();
  });

  it("returns null when emailSentAt is unparseable", () => {
    expect(chaseStatusLine(base({ emailSentAt: "not-a-date" }))).toBeNull();
  });
});

describe("chaseStatusLine — QUOTED (quote chase)", () => {
  it("step 0, before day 2 → no chase yet, first goes around", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 0 }));
    expect(r).toEqual({ text: "No chase yet · first goes around 12 Jul", tone: "muted" });
  });

  it("step 0, day 2 reached (cron not yet run) → first chase due", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 0, now: new Date("2026-07-13T08:00:00Z") }));
    expect(r).toEqual({ text: "No chase yet · first chase due 12 Jul", tone: "muted" });
  });

  it("step 1 → chase 1 of 3 sent 12 Jul, next around 15 Jul", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 1 }));
    expect(r).toEqual({ text: "Chase 1 of 3 sent 12 Jul · next around 15 Jul", tone: "muted" });
  });

  it("step 2 → chase 2 of 3 sent 15 Jul, next around 20 Jul", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 2 }));
    expect(r).toEqual({ text: "Chase 2 of 3 sent 15 Jul · next around 20 Jul", tone: "muted" });
  });

  it("step 3 → all chases sent, call task raised (warn)", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 3 }));
    expect(r).toEqual({ text: "All 3 chases sent · call task raised", tone: "warn" });
  });

  it("paused → chasing paused, customer replied", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 2, chasePaused: true }));
    expect(r).toEqual({ text: "Chasing paused · customer replied", tone: "muted" });
  });

  it("paused takes precedence over an exhausted step", () => {
    const r = chaseStatusLine(base({ quoteChaseStep: 3, chasePaused: true }));
    expect(r?.text).toBe("Chasing paused · customer replied");
  });

  it("next-around flips to next-chase-due once the scheduled day has arrived", () => {
    // step 1, now past the day-5 (15 Jul) mark — cron pending its next run.
    const r = chaseStatusLine(base({ quoteChaseStep: 1, now: new Date("2026-07-16T08:00:00Z") }));
    expect(r).toEqual({ text: "Chase 1 of 3 sent 12 Jul · next chase due 15 Jul", tone: "muted" });
  });
});

describe("chaseStatusLine — PROVISIONAL (deposit chase)", () => {
  const dep = (o: Partial<ChaseStatusLineArgs> = {}): ChaseStatusLineArgs =>
    base({
      leadStatus: "provisional",
      quoteStatus: "accepted",
      emailSentAt: null,
      acceptedAt: ACCEPTED,
      now: new Date("2026-07-14T12:00:00Z"),
      ...o,
    });

  it("step 0, before day 1 → no deposit reminder yet, first goes around 15 Jul", () => {
    const r = chaseStatusLine(dep({ depositChaseStep: 0 }));
    expect(r).toEqual({ text: "No deposit reminder yet · first goes around 15 Jul", tone: "muted" });
  });

  it("step 1 → deposit reminder 1 of 2 sent 15 Jul, next around 17 Jul", () => {
    const r = chaseStatusLine(dep({ depositChaseStep: 1 }));
    expect(r).toEqual({ text: "Deposit reminder 1 of 2 sent 15 Jul · next around 17 Jul", tone: "muted" });
  });

  it("step 2 → both deposit reminders sent, call task raised (warn)", () => {
    const r = chaseStatusLine(dep({ depositChaseStep: 2 }));
    expect(r).toEqual({ text: "Both deposit reminders sent · call task raised", tone: "warn" });
  });

  it("paused → chasing paused, customer replied", () => {
    const r = chaseStatusLine(dep({ depositChaseStep: 1, chasePaused: true }));
    expect(r).toEqual({ text: "Chasing paused · customer replied", tone: "muted" });
  });

  it("returns null when the driving quote isn't accepted yet", () => {
    expect(chaseStatusLine(dep({ quoteStatus: "sent" }))).toBeNull();
  });

  it("returns null when acceptedAt is missing", () => {
    expect(chaseStatusLine(dep({ acceptedAt: null }))).toBeNull();
  });
});
