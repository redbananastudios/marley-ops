/**
 * chase-status.ts — a plain-English "where is the chase engine on this lead"
 * line for the office. Pure + unit-tested; the daily cron does the sending,
 * this only describes the state the office can never otherwise see ("has chase 2
 * gone out? when's the next?").
 *
 * Cadences mirror lib/quote/chase.ts:
 *  - QUOTED       quote emails on day 2 / 5 / 10 after the quote email, then a
 *                 human call task once all three are sent.
 *  - PROVISIONAL  deposit reminders on day 1 / 3 after acceptance, then a call.
 *
 * Chasing stops (and this line disappears) once the lead leaves those two
 * statuses — accepted+deposit paid → confirmed, completed, or declined.
 *
 * Dates are "around" because the daily cron fires once a day, so the actual send
 * lands on-or-after the scheduled day. We derive the scheduled dates from the
 * quote's email/accept timestamp + the cadence offsets (the per-step send time
 * isn't carried on the lead), which is accurate to the day the office cares about.
 */

import { QUOTE_CHASE_DAYS, DEPOSIT_CHASE_DAYS } from "./chase";

export type ChaseTone = "muted" | "warn";

export interface ChaseStatusLineArgs {
  /** Lead status — only "quoted" / "provisional" ever produce a line. */
  leadStatus: string | null;
  /** The human/inbound stop switch (a customer reply, or handed to a person). */
  chasePaused: boolean;
  /** The driving quote's status: "sent" drives the quote chase, "accepted" the deposit chase. */
  quoteStatus: string | null;
  /** quotes.email_sent_at — anchors the quote-chase schedule. */
  emailSentAt: string | null;
  /** quotes.accepted_at — anchors the deposit-chase schedule. */
  acceptedAt: string | null;
  /** leads.quote_chase_step (0..3). */
  quoteChaseStep: number;
  /** leads.deposit_chase_step (0..2). */
  depositChaseStep: number;
  /** Defaults to now; injected in tests. */
  now?: Date;
}

export interface ChaseStatus {
  text: string;
  tone: ChaseTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (iso: string, days: number): Date =>
  new Date(new Date(iso).getTime() + days * DAY_MS);

/** UK short date, e.g. "12 Jul". */
function ukDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
}

/** "first goes around 12 Jul" (upcoming) vs "first chase due 12 Jul" (the day has
 *  arrived and the next cron run will send). Uses `now` so the office can tell a
 *  scheduled-but-not-yet-fired chase from one that's imminent. */
function whenPhrase(target: Date, now: Date, kind: "first" | "next"): string {
  const date = ukDate(target);
  const reached = now.getTime() >= target.getTime();
  if (kind === "first") return reached ? `first chase due ${date}` : `first goes around ${date}`;
  return reached ? `next chase due ${date}` : `next around ${date}`;
}

const isValidDate = (iso: string): boolean => !Number.isNaN(new Date(iso).getTime());

export function chaseStatusLine(args: ChaseStatusLineArgs): ChaseStatus | null {
  const { leadStatus, chasePaused, quoteStatus, emailSentAt, acceptedAt } = args;
  const now = args.now ?? new Date();
  const quoteChaseStep = args.quoteChaseStep ?? 0;
  const depositChaseStep = args.depositChaseStep ?? 0;

  /* -------------------------------------------------- QUOTED: quote chase */
  if (leadStatus === "quoted") {
    // Only the live sent quote drives the chase — an old draft/superseded quote
    // the office happens to be viewing shows nothing.
    if (quoteStatus !== "sent" || !emailSentAt || !isValidDate(emailSentAt)) return null;

    const total = QUOTE_CHASE_DAYS.length; // 3
    if (chasePaused) return { text: "Chasing paused · customer replied", tone: "muted" };
    if (quoteChaseStep >= total) {
      return { text: `All ${total} chases sent · call task raised`, tone: "warn" };
    }
    if (quoteChaseStep <= 0) {
      const first = addDays(emailSentAt, QUOTE_CHASE_DAYS[0]);
      return { text: `No chase yet · ${whenPhrase(first, now, "first")}`, tone: "muted" };
    }
    const sent = ukDate(addDays(emailSentAt, QUOTE_CHASE_DAYS[quoteChaseStep - 1]));
    const next = addDays(emailSentAt, QUOTE_CHASE_DAYS[quoteChaseStep]);
    return {
      text: `Chase ${quoteChaseStep} of ${total} sent ${sent} · ${whenPhrase(next, now, "next")}`,
      tone: "muted",
    };
  }

  /* --------------------------------------------- PROVISIONAL: deposit chase */
  if (leadStatus === "provisional") {
    if (quoteStatus !== "accepted" || !acceptedAt || !isValidDate(acceptedAt)) return null;

    const total = DEPOSIT_CHASE_DAYS.length; // 2
    if (chasePaused) return { text: "Chasing paused · customer replied", tone: "muted" };
    if (depositChaseStep >= total) {
      const lead = total === 2 ? "Both" : `All ${total}`;
      return { text: `${lead} deposit reminders sent · call task raised`, tone: "warn" };
    }
    if (depositChaseStep <= 0) {
      const first = addDays(acceptedAt, DEPOSIT_CHASE_DAYS[0]);
      return { text: `No deposit reminder yet · ${whenPhrase(first, now, "first")}`, tone: "muted" };
    }
    const sent = ukDate(addDays(acceptedAt, DEPOSIT_CHASE_DAYS[depositChaseStep - 1]));
    const next = addDays(acceptedAt, DEPOSIT_CHASE_DAYS[depositChaseStep]);
    return {
      text: `Deposit reminder ${depositChaseStep} of ${total} sent ${sent} · ${whenPhrase(next, now, "next")}`,
      tone: "muted",
    };
  }

  return null;
}
