import { describe, expect, it } from "vitest";
import {
  balanceReminderTemplate,
  depositReminderTemplate,
  missedCallTemplate,
  templateForReason,
} from "@/lib/comms/templates";

/** Canned follow-up copy. Multi-brand (PRD §3.5): brandName/brandPhone drive
 *  the sign-off, the "it's X" lines and the callback number; a context without
 *  them is byte-locked to today's Marley copy. */

const ctx = { firstName: "Jane Smith", quoteRef: "MMR042", amount: 100, moveDate: "14 Jul" };

describe("marley default copy is byte-identical to the pre-brand templates", () => {
  // Exact strings from the pre-change implementation — if these fail, live
  // Marley follow-up copy changed. Only update for a deliberate copy change.
  it("missed call", () => {
    const t = missedCallTemplate(ctx);
    expect(t.email).toBe(`Hi Jane,

We tried to give you a call about your move enquiry but couldn't get hold of you.

We'd love to help. Reply to this email or call us back on 01747 637070 and we'll pick it straight up.

Thanks,
Marley Moves`);
    expect(t.sms).toBe(
      "Hi Jane, it's Marley Moves. We tried calling about your move enquiry. Call us back on 01747 637070 or reply here and we'll sort it. Thanks!",
    );
  });

  it("deposit reminder", () => {
    const t = depositReminderTemplate(ctx);
    expect(t.subject).toBe("Your deposit (quote MMR042)");
    expect(t.email).toBe(`Hi Jane,

Just a gentle reminder that the £100 deposit (quote MMR042) for your move on 14 Jul is still outstanding. Once it's in, your booking is secured and confirming your date is the next quick step.

If you've already sent it, please ignore this. Any questions, call 01747 637070.

Thanks,
Marley Moves`);
    expect(t.sms).toBe(
      "Hi Jane, Marley Moves here. A quick reminder the £100 deposit for your move on 14 Jul is still outstanding. Once paid your booking is secured. Questions? 01747 637070.",
    );
  });

  it("balance reminder", () => {
    const t = balanceReminderTemplate({ ...ctx, amount: 1250 });
    expect(t.subject).toBe("Remaining balance (quote MMR042)");
    expect(t.email).toBe(`Hi Jane,

A quick reminder that the remaining balance of £1,250 for your move on 14 Jul is now due.

If you've already paid, please ignore this. Any questions at all, call us on 01747 637070.

Thanks,
Marley Moves`);
    expect(t.sms).toBe(
      "Hi Jane, Marley Moves here. The remaining balance of £1,250 for your move on 14 Jul is now due. Already paid? Please ignore this. Questions? 01747 637070.",
    );
  });

  it("explicit marley values render the same bytes as absent ones", () => {
    for (const reason of ["missed_call", "deposit", "balance"]) {
      const plain = templateForReason(reason, ctx);
      const explicit = templateForReason(reason, {
        ...ctx,
        brandName: "Marley Moves",
        brandPhone: "01747 637070",
      });
      expect(explicit).toEqual(plain);
      const nulled = templateForReason(reason, { ...ctx, brandName: null, brandPhone: null });
      expect(nulled).toEqual(plain);
    }
  });
});

describe("brand-aware copy", () => {
  const pitmansCtx = {
    ...ctx,
    quoteRef: "PMR034",
    brandName: "Pitmans Removals & Storage",
    brandPhone: "01258 858564",
  };

  it("names the brand and its phone everywhere the copy names Marley today", () => {
    for (const reason of ["missed_call", "deposit", "balance"]) {
      const t = templateForReason(reason, pitmansCtx);
      for (const body of [t.email, t.sms]) {
        expect(body).toContain("Pitmans Removals & Storage");
        expect(body).toContain("01258 858564");
        expect(body).not.toContain("Marley");
        expect(body).not.toContain("01747");
      }
    }
  });

  it("blank brand fields fall back to the Marley literals", () => {
    const t = missedCallTemplate({ ...ctx, brandName: "  ", brandPhone: "" });
    expect(t.email).toContain("Marley Moves");
    expect(t.email).toContain("01747 637070");
  });
});
