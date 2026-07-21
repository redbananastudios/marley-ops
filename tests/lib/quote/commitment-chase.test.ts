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
  dateReleasableAt: null,
  chasePaused: false,
};

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
  it("flags at exactly 7 days out (and the un-stamped chase fires in the same run)", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-08" }, NOW)).toEqual([
      "chase",
      "flag",
    ]);
  });

  it("does not flag at 8 days out", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-09" }, NOW)).toEqual(["chase"]);
  });

  it("flags on move day itself (day 0)", () => {
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-01" }, NOW)).toEqual([
      "chase",
      "flag",
    ]);
  });

  it("flag fires alone once the T-10 chase is already stamped", () => {
    expect(
      dueCommitmentActions(
        { ...base, movingDate: "2026-08-08", commitmentChaseT10At: "2026-07-29T09:00:00Z" },
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

  it("one shot: the shared T-10 stamp suppresses a repeat task", () => {
    expect(
      dueCommitmentActions({ ...unconfirmed, commitmentChaseT10At: "2026-08-01T09:00:00Z" }, NOW),
    ).toEqual([]);
  });
});

describe("dueCommitmentActions — chase_paused", () => {
  it("suppresses the chase email but NOT the internal T-7 flag", () => {
    // A paused conversation must not hide an at-risk date from the office.
    expect(
      dueCommitmentActions({ ...base, movingDate: "2026-08-08", chasePaused: true }, NOW),
    ).toEqual(["flag"]);
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
    // is 7 UK days out (UTC maths would say 8) → the T-7 flag is due NOW.
    const lateNight = new Date("2026-08-01T23:30:00Z");
    expect(dueCommitmentActions({ ...base, movingDate: "2026-08-09" }, lateNight)).toEqual([
      "chase",
      "flag",
    ]);
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
