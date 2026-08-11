import { describe, expect, it } from "vitest";
import { planSuppressionFlags, type ReconcilableLead, type SuppressionEntry } from "@/lib/comms/suppressions";

const lead = (over: Partial<ReconcilableLead> = {}): ReconcilableLead => ({
  id: "lead-1",
  client_id: "client-1",
  email: "kat@example.com",
  status: "quoted",
  email_invalid_at: null,
  ...over,
});

const supp = (email: string, over: Partial<SuppressionEntry> = {}): SuppressionEntry => ({
  email,
  origin: "bounce",
  created_at: "2026-07-31 18:47:43.930459+00",
  ...over,
});

describe("planSuppressionFlags", () => {
  it("flags a live lead sitting on a suppressed address", () => {
    const flags = planSuppressionFlags([supp("kat@example.com")], [lead()]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ leadId: "lead-1", clientId: "client-1", kind: "hard", origin: "bounce" });
    // The flag carries the date delivery actually started failing, not today —
    // an office looking at the lead needs to know how long it has been dark.
    expect(flags[0].at).toBe("2026-07-31T18:47:43.930Z");
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const flags = planSuppressionFlags(
      [supp("  KAT@Example.COM ")],
      [lead({ email: "Kat@example.com" })],
    );
    expect(flags).toHaveLength(1);
  });

  it("leaves an already-flagged lead alone so the daily run cannot re-alert", () => {
    const flags = planSuppressionFlags(
      [supp("kat@example.com")],
      [lead({ email_invalid_at: "2026-07-31T18:47:43Z" })],
    );
    expect(flags).toEqual([]);
  });

  it("skips finished business — a declined or completed lead is not worth a call task", () => {
    for (const status of ["declined", "completed", "cancelled"]) {
      expect(planSuppressionFlags([supp("kat@example.com")], [lead({ status })])).toEqual([]);
    }
  });

  it("still flags a CONFIRMED customer, which is the most urgent case of all", () => {
    // Mela Noble (2026-08-05): a confirmed move three weeks out whose address
    // had been dead since the quote went out. Nobody would have found out until
    // the crew turned up, because every email we sent was silently dropped.
    const flags = planSuppressionFlags([supp("kat@example.com")], [lead({ status: "confirmed" })]);
    expect(flags).toHaveLength(1);
  });

  it("reads a spam complaint as a complaint, not a bounce", () => {
    const flags = planSuppressionFlags([supp("kat@example.com", { origin: "complaint" })], [lead()]);
    expect(flags[0].kind).toBe("complaint");
  });

  it("keeps the EARLIEST record when an address is listed more than once", () => {
    const flags = planSuppressionFlags(
      [
        supp("kat@example.com", { created_at: "2026-08-05 09:00:00+00" }),
        supp("kat@example.com", { created_at: "2026-07-31 18:47:43.930459+00" }),
      ],
      [lead()],
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].at).toBe("2026-07-31T18:47:43.930Z");
  });

  it("ignores leads with no email, and suppressions with no address", () => {
    expect(planSuppressionFlags([supp("kat@example.com")], [lead({ email: null })])).toEqual([]);
    expect(planSuppressionFlags([supp("")], [lead()])).toEqual([]);
  });

  it("does not flag a lead whose address is merely similar", () => {
    expect(planSuppressionFlags([supp("kat@example.com")], [lead({ email: "kat@example.co" })])).toEqual([]);
  });

  it("survives a suppression entry with no timestamp", () => {
    const flags = planSuppressionFlags([supp("kat@example.com", { created_at: null })], [lead()]);
    expect(flags).toHaveLength(1);
    expect(flags[0].at).toBeUndefined();
  });
});
