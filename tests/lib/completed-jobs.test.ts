import { describe, expect, it } from "vitest";
import {
  buildCompletedJobRows,
  type CompletedCompletion,
  type CompletedLead,
  type CompletedQuote,
  type CompletedRemovalAppt,
} from "@/lib/completed-jobs";

const lead = (o: Partial<CompletedLead>): CompletedLead => ({
  id: o.id ?? "l",
  name: "Jane Doe",
  client_id: "c",
  updated_at: "2026-07-01T09:00:00+01:00",
  from_postcode: null,
  to_postcode: null,
  review_requested_at: null,
  review_suppressed: false,
  ...o,
});

const appt = (o: Partial<CompletedRemovalAppt>): CompletedRemovalAppt => ({
  lead_id: o.lead_id ?? "l",
  starts_at: o.starts_at ?? "2026-07-10T08:00:00+01:00",
});

const quote = (o: Partial<CompletedQuote>): CompletedQuote => ({
  lead_id: o.lead_id ?? "l",
  quote_ref: "MM-260701-001",
  status: "accepted",
  agreed_price: null,
  grand_total: 1000,
  accepted_at: null,
  created_at: "2026-07-01T09:00:00+01:00",
  ...o,
});

const completion = (o: Partial<CompletedCompletion>): CompletedCompletion => ({
  lead_id: o.lead_id ?? "l",
  exceptions: "",
  certificate_path: null,
  signed_at: "2026-07-10T18:00:00+01:00",
  ...o,
});

describe("buildCompletedJobRows", () => {
  it("shapes one row per lead with move date, value, cert and review state", () => {
    const rows = buildCompletedJobRows({
      leads: [
        lead({ id: "l1", name: "Jane Doe", from_postcode: "SP7 8AA", to_postcode: "DT9 3AA", review_requested_at: "2026-07-11T09:00:00+01:00" }),
      ],
      appointments: [appt({ lead_id: "l1", starts_at: "2026-07-09T08:00:00+01:00" })],
      quotes: [quote({ lead_id: "l1", agreed_price: 1200, grand_total: 1300 })],
      completions: [completion({ lead_id: "l1", certificate_path: "job-docs/cert-1.pdf" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      leadId: "l1",
      customer: "Jane Doe",
      route: "SP7 8AA → DT9 3AA",
      moveAt: "2026-07-09T08:00:00+01:00",
      quoteRef: "MM-260701-001",
      value: 1200, // agreed price wins over grand total
      certificatePath: "job-docs/cert-1.pdf",
      review: "sent",
      hasExceptions: false,
    });
  });

  it("uses the latest removal appointment and falls back to updated_at for sorting", () => {
    const rows = buildCompletedJobRows({
      leads: [
        lead({ id: "withMove", name: "Has Move", updated_at: "2026-06-01T09:00:00+01:00" }),
        lead({ id: "noMove", name: "No Move", updated_at: "2026-07-10T09:00:00+01:00" }),
      ],
      appointments: [
        appt({ lead_id: "withMove", starts_at: "2026-07-01T08:00:00+01:00" }),
        appt({ lead_id: "withMove", starts_at: "2026-07-15T08:00:00+01:00" }), // later → wins
      ],
      quotes: [],
      completions: [],
    });
    // withMove takes the LATER of its two appointments (15 Jul, not 1 Jul); noMove
    // has no appointment so it falls back to its updated_at (10 Jul). Ordered
    // newest-first by that key → withMove (15 Jul) above noMove (10 Jul).
    expect(rows.map((r) => r.leadId)).toEqual(["withMove", "noMove"]);
    expect(rows[0].moveAt).toBe("2026-07-15T08:00:00+01:00");
    expect(rows[1].moveAt).toBeNull();
    expect(rows[1].sortAt).toBe("2026-07-10T09:00:00+01:00");
  });

  it("prefers the accepted quote and a completion that has a certificate", () => {
    const rows = buildCompletedJobRows({
      leads: [lead({ id: "l1" })],
      appointments: [],
      quotes: [
        quote({ lead_id: "l1", quote_ref: "MM-OLD", status: "superseded", grand_total: 500 }),
        quote({ lead_id: "l1", quote_ref: "MM-WON", status: "accepted", agreed_price: 900 }),
      ],
      completions: [
        completion({ lead_id: "l1", certificate_path: null, signed_at: "2026-07-11T18:00:00+01:00" }),
        completion({ lead_id: "l1", certificate_path: "job-docs/c.pdf", signed_at: "2026-07-10T18:00:00+01:00" }),
      ],
    });
    expect(rows[0].quoteRef).toBe("MM-WON");
    expect(rows[0].value).toBe(900);
    expect(rows[0].certificatePath).toBe("job-docs/c.pdf");
  });

  it("review state: suppressed → off, exceptions flagged from the completion", () => {
    const rows = buildCompletedJobRows({
      leads: [
        lead({ id: "off", review_requested_at: null, review_suppressed: true }),
        lead({ id: "pending", review_requested_at: null, review_suppressed: false }),
      ],
      appointments: [],
      quotes: [],
      completions: [completion({ lead_id: "off", exceptions: "  scuffed a wall  " })],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.leadId, r]));
    expect(byId.off.review).toBe("off");
    expect(byId.off.hasExceptions).toBe(true);
    expect(byId.pending.review).toBe("pending");
    expect(byId.pending.hasExceptions).toBe(false);
  });

  it("search matches customer name or quote ref, case-insensitively", () => {
    const input = {
      leads: [lead({ id: "l1", name: "Alice Ng" }), lead({ id: "l2", name: "Bob Ray" })],
      appointments: [],
      quotes: [quote({ lead_id: "l2", quote_ref: "MM-260714-042" })],
      completions: [],
    };
    expect(buildCompletedJobRows({ ...input, search: "alice" }).map((r) => r.leadId)).toEqual(["l1"]);
    expect(buildCompletedJobRows({ ...input, search: "260714" }).map((r) => r.leadId)).toEqual(["l2"]);
    expect(buildCompletedJobRows({ ...input, search: "  " }).map((r) => r.leadId).sort()).toEqual(["l1", "l2"]);
  });
});
