import { describe, expect, it } from "vitest";
import {
  dueCommitmentActions,
  postMoveOutstanding,
  type CommitmentSweepInput,
} from "@/lib/quote/chase";

/**
 * Commitment ladder decisions (Payments Policy v2 — PRD §5B). Load-bearing:
 * these thresholds decide when a customer is emailed about money and when a
 * booked date is flagged at risk — both boundaries are locked on both sides,
 * in UK wall-clock days.
 */

// 2026-08-01T10:00:00Z = 11:00 BST → UK day 2026-08-01.
const NOW = new Date("2026-08-01T10:00:00Z");

const base: CommitmentSweepInput = {
  movingDate: "2026-08-11", // 10 UK days out from NOW
  dateConfirmedAt: "2026-07-20T10:00:00Z",
  zohoCommitmentInvoiceId: "zoho-inv-123",
  commitmentInvoiceAmount: 500,
  commitmentPaidAt: null,
  commitmentChaseT10At: null,
  dateConfirmNudgeAt: null,
  dateReleasableAt: null,
  chasePaused: false,
};

describe("dueCommitmentActions — the two T-10 one-shots are independent", () => {
  // One shared stamp used to gate BOTH the internal "confirm the date" call
  // task and the customer's commitment reminder. The internal one fires first
  // by construction (an unconfirmed date at T-10 is exactly what precedes
  // confirmation), so it consumed the stamp and the customer — now invoiced 25%
  // — never received a word about it.
  const unconfirmed: CommitmentSweepInput = { ...base, dateConfirmedAt: null };

  it("nudges the office when the date is not confirmed inside 10 days", () => {
    expect(dueCommitmentActions(unconfirmed, NOW)).toEqual(["confirm_date_call"]);
  });

  it("nudges only once", () => {
    expect(dueCommitmentActions({ ...unconfirmed, dateConfirmNudgeAt: "2026-07-31T10:00:00Z" }, NOW)).toEqual([]);
  });

  it("a spent confirm-date nudge does NOT silence the customer commitment reminder", () => {
    // The regression: nudge already sent, customer then confirms their date and
    // is invoiced. They must still be told the 25% is due.
    const confirmedAfterNudge: CommitmentSweepInput = {
      ...base,
      dateConfirmNudgeAt: "2026-07-31T10:00:00Z",
      commitmentChaseT10At: null,
    };
    expect(dueCommitmentActions(confirmedAfterNudge, NOW)).toEqual(["chase"]);
  });

  it("and a spent customer reminder does not re-open the internal nudge", () => {
    expect(
      dueCommitmentActions({ ...unconfirmed, commitmentChaseT10At: "2026-07-31T10:00:00Z" }, NOW),
    ).toEqual(["confirm_date_call"]);
  });
});

describe("dueCommitmentActions — T-10 chase threshold", () => {
  it("chases at exactly 10 days out (inclusive)", () => {
    expect(dueCommitmentActions(base, NOW)).toEqual(["chase"]);
  });

  it("does nothing at 11 days out", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-12" }, NOW)).toEqual([]);
  });

  it("still chases when the cron catches up late (e.g. 9 days out, never stamped)", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-10" }, NOW)).toEqual(["chase"]);
  });

  it("never re-chases once commitment_chase_t10_at is stamped", () => {
    expect(
      dueCommitmentActions({ ...base, commitmentChaseT10At: "2026-08-01T09:00:00Z" }, NOW),
    ).toEqual([]);
  });
});

describe("dueCommitmentActions — T-7 flag threshold", () => {
  it("never flags in the same run as the first chase — the chase goes out alone (Brydee MMR034)", () => {
    // A late confirmation lands inside both windows at once; the customer must
    // get their reminder AND the grace window before the office alarm sounds.
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-08" }, NOW)).toEqual(["chase"]);
  });

  it("does not flag at 8 days out", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-09" }, NOW)).toEqual(["chase"]);
  });

  it("on move day an un-chased booking still only chases (the queue's overdue bucket covers visibility)", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-01" }, NOW)).toEqual(["chase"]);
  });

  it("flag fires alone once the T-10 chase is already stamped (normal path: stamp is days old)", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", commitmentChaseT10At: "2026-07-29T09:00:00Z" },
        NOW,
      ),
    ).toEqual(["flag"]);
  });

  it("the flag waits until the chase is 24h old — a fresh chase stamp defers it", () => {
    // Chased 2h ago: the customer is mid-grace; paying now ends the ladder
    // silently and the office alarm never sounds.
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", commitmentChaseT10At: "2026-08-01T08:00:00Z" },
        NOW,
      ),
    ).toEqual([]);
  });

  it("flags once the chase is ≥24h old (boundary inclusive)", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", commitmentChaseT10At: "2026-07-31T10:00:00Z" },
        NOW,
      ),
    ).toEqual(["flag"]);
  });

  it("never re-flags once date_releasable_at is stamped", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", dateReleasableAt: "2026-08-01T09:00:00Z" },
        NOW,
      ),
    ).toEqual(["chase"]);
  });

  it("fully stamped → nothing", () => {
    expect(
      dueCommitmentActions(
        {
          ...base,
          movingDate: "2026-08-08",
          commitmentChaseT10At: "2026-07-29T09:00:00Z",
          dateReleasableAt: "2026-08-01T09:00:00Z",
        },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("dueCommitmentActions — unconfirmed-date branch", () => {
  const unconfirmed = { ...base, dateConfirmedAt: null, zohoCommitmentInvoiceId: null, commitmentInvoiceAmount: null };

  it("raises the confirm-the-date call task at 10 days out instead of any email", () => {
    expect(dueCommitmentActions(unconfirmed, NOW)).toEqual(["confirm_date_call"]);
  });

  it("nothing at 11 days out", () => {
    expect(dueCommitmentActions({ ...unconfirmed, movingDate: "2026-08-12" }, NOW)).toEqual([]);
  });

  it("still only the call task inside 7 days — the T-7 flag needs a raised invoice", () => {
    expect(dueCommitmentActions({ ...unconfirmed, movingDate: "2026-08-04" }, NOW)).toEqual([
      "confirm_date_call",
    ]);
  });

  it("one shot: its OWN stamp suppresses a repeat task", () => {
    expect(
      dueCommitmentActions({ ...unconfirmed, dateConfirmNudgeAt: "2026-08-01T09:00:00Z" }, NOW),
    ).toEqual([]);
  });

  it("the customer-reminder stamp is not its stamp — an unconfirmed date still nudges", () => {
    // This assertion is INVERTED from the original, deliberately. The two
    // one-shots used to share commitment_chase_t10_at, so either could silence
    // the other; the damaging direction was the internal nudge suppressing the
    // customer's 25%-due reminder entirely. They are independent now, and an
    // unconfirmed date near the move always deserves the call.
    expect(
      dueCommitmentActions({ ...unconfirmed, commitmentChaseT10At: "2026-08-01T09:00:00Z" }, NOW),
    ).toEqual(["confirm_date_call"]);
  });
});

describe("dueCommitmentActions — chase_paused", () => {
  it("suppresses the chase email but NOT the internal T-7 flag", () => {
    // A paused conversation must not hide an at-risk date from the office —
    // the flag's grace anchor falls back to confirmation (12 days old here).
    expect(
      dueCommitmentActions({ ...base, movingDate: "2026-08-08", chasePaused: true }, NOW),
    ).toEqual(["flag"]);
  });

  it("a paused lead confirmed under 24h ago gets the same grace before the flag", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", chasePaused: true, dateConfirmedAt: "2026-08-01T09:00:00Z" },
        NOW,
      ),
    ).toEqual([]);
  });

  it("suppresses the T-10 chase outright", () => {
    expect(dueCommitmentActions({ ...base, chasePaused: true }, NOW)).toEqual([]);
  });

  it("suppresses the confirm-date call task", () => {
    expect(
      dueCommitmentActions({ ...base, dateConfirmedAt: null, chasePaused: true }, NOW),
    ).toEqual([]);
  });
});

describe("dueCommitmentActions — invoice guards (confirmed branch)", () => {
  it("no invoice raised → nothing to chase or flag", () => {
    expect(
      dueCommitmentActions({ ...base, movingDate: "2026-08-05", zohoCommitmentInvoiceId: null }, NOW),
    ).toEqual([]);
  });

  it("'pending' is the in-flight claim marker, never a raised invoice", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-05", zohoCommitmentInvoiceId: "pending" },
        NOW,
      ),
    ).toEqual([]);
  });

  it("paid commitment → sequence over", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-05", commitmentPaidAt: "2026-07-30T09:00:00Z" },
        NOW,
      ),
    ).toEqual([]);
  });

  it("zero-commitment edge (25% ≤ deposit, nothing invoiced) → nothing due", () => {
    expect(
      dueCommitmentActions({ ...base, movingDate: "2026-08-05", commitmentInvoiceAmount: 0 }, NOW),
    ).toEqual([]);
  });
});

describe("dueCommitmentActions — date bounds + UK day maths", () => {
  it("a passed move date belongs to the post-move sweep", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-07-31" }, NOW)).toEqual([]);
  });

  it("missing / garbage move date → nothing", () => {
    expect(dueCommitmentActions({ ...base, movingDate: null }, NOW)).toEqual([]);
    expect(dueCommitmentActions({ ...base, movingDate: "not-a-date" }, NOW)).toEqual([]);
  });

  it("counts UK wall-clock days, not UTC (23:30Z in summer is already tomorrow in the UK)", () => {
    // 2026-08-01T23:30:00Z = 00:30 BST on 2026-08-02 → the move on 2026-08-09
    // is 7 UK days out (UTC maths would say 8) → with the chase already a day
    // old, the T-7 flag is due NOW.
    const lateNight = new Date("2026-08-01T23:30:00Z");
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-09", commitmentChaseT10At: "2026-07-30T09:00:00Z" },
        lateNight,
      ),
    ).toEqual(["flag"]);
  });
});

/* --------------------------------------------------- postMoveOutstanding */

describe("postMoveOutstanding — the post-move sweep maths (PRD §8.5/8.6)", () => {
  const money = {
    agreed: 2400,
    depositAmount: 100,
    depositPaidAt: "2026-07-01T10:00:00Z",
    commitmentInvoiceAmount: 500,
    commitmentPaidAt: "2026-07-20T10:00:00Z",
    balancePaidAt: null,
  };

  it("PRD worked example: £2,400 job, £100 deposit + £500 commitment paid → £1,800 outstanding", () => {
    expect(postMoveOutstanding(money)).toBe(1800);
  });

  it("deposit paid, commitment raised but UNPAID → the alarm shows £2,300, not £1,800", () => {
    expect(postMoveOutstanding({ ...money, commitmentPaidAt: null })).toBe(2300);
  });

  it("balance_paid_at zeroes everything — a paid-commitment settled job auto-completes", () => {
    expect(postMoveOutstanding({ ...money, balancePaidAt: "2026-08-10T10:00:00Z" })).toBe(0);
    // Even with odd stamps, the office's "all settled" mark wins.
    expect(
      postMoveOutstanding({ ...money, commitmentPaidAt: null, balancePaidAt: "2026-08-10T10:00:00Z" }),
    ).toBe(0);
  });

  it("only money that LANDED reduces the figure — an unpaid deposit is still owed", () => {
    expect(postMoveOutstanding({ ...money, depositPaidAt: null, commitmentPaidAt: null })).toBe(2400);
  });

  it("no commitment machinery at all (pre-v2 rows) → agreed minus the paid deposit", () => {
    expect(
      postMoveOutstanding({ ...money, commitmentInvoiceAmount: null, commitmentPaidAt: null }),
    ).toBe(2300);
  });

  it("never negative", () => {
    expect(
      postMoveOutstanding({ ...money, agreed: 100, commitmentInvoiceAmount: 500 }),
    ).toBe(0);
  });

  it("rounds to 2dp", () => {
    expect(postMoveOutstanding({ ...money, agreed: 999.99, commitmentPaidAt: null })).toBe(899.99);
  });
});

describe("dueCommitmentActions — stamps reset on a date change re-arm the ladder", () => {
  // The ladder's one-shot stamps are per MOVE DATE: both date-change paths
  // (rescheduleAppointment + the inside-window rebook) null
  // commitment_chase_t10_at and date_releasable_at whenever an unpaid
  // commitment's move date changes. These lock the pure consequence: cleared
  // stamps mean the NEW date chases and flags again at its own thresholds.
  it("a cleared T-10 stamp chases again for the rescheduled date", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-11", commitmentChaseT10At: null, dateReleasableAt: null },
        NOW,
      ),
    ).toEqual(["chase"]);
  });

  it("a cleared T-7 flag re-flags when the new date reaches move-7d unpaid", () => {
    expect(
      dueCommitmentActions(
        {
          ...base,
          movingDate: "2026-08-08",
          commitmentChaseT10At: "2026-07-30T09:00:00Z", // chase already sent for the new date
          dateReleasableAt: null, // reset by the date change
        },
        NOW,
      ),
    ).toEqual(["flag"]);
  });

  it("stale stamps (NOT reset) silence the ladder — the failure mode the reset closes", () => {
    expect(
      dueCommitmentActions(
        {
          ...base,
          movingDate: "2026-08-11",
          commitmentChaseT10At: "2026-07-01T09:00:00Z", // stamped against the OLD date
        },
        NOW,
      ),
    ).toEqual([]);
  });
});
