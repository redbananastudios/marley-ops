import { describe, expect, it } from "vitest";
import {
  decideSheetAction,
  windowOpen,
  targetWorkDates,
  smsBody,
  emailHtml,
  type SheetStateRow,
} from "@/lib/crew-sheet/dispatch";
import type { CrewDaySheet } from "@/lib/crew-sheet/daily-data";

const row = (over: Partial<SheetStateRow> = {}): SheetStateRow => ({
  id: "r1",
  version: 1,
  content_hash: "h1",
  delivered_hash: null,
  attempts: 0,
  token: "tok",
  ...over,
});

describe("decideSheetAction", () => {
  it("waits before the send window opens when nothing sent yet", () => {
    expect(decideSheetAction({ currentHash: "h1", eligible: false, row: null })).toEqual({ kind: "wait" });
  });

  it("sends the first copy once eligible", () => {
    expect(decideSheetAction({ currentHash: "h1", eligible: true, row: null })).toEqual({
      kind: "send",
      contentChanged: true,
      superseding: false,
    });
  });

  it("does nothing when the current content is already delivered", () => {
    expect(
      decideSheetAction({ currentHash: "h1", eligible: true, row: row({ content_hash: "h1", delivered_hash: "h1" }) }),
    ).toEqual({ kind: "done" });
  });

  it("re-sends a SUPERSEDING copy when the content changed after delivery", () => {
    expect(
      decideSheetAction({ currentHash: "h2", eligible: true, row: row({ content_hash: "h1", delivered_hash: "h1" }) }),
    ).toEqual({ kind: "send", contentChanged: true, superseding: true });
  });

  it("a content change before first delivery is not superseding", () => {
    expect(
      decideSheetAction({ currentHash: "h2", eligible: true, row: row({ content_hash: "h1", delivered_hash: null }) }),
    ).toEqual({ kind: "send", contentChanged: true, superseding: false });
  });

  it("retries the same undelivered content until the attempt cap", () => {
    expect(
      decideSheetAction({ currentHash: "h1", eligible: true, row: row({ content_hash: "h1", delivered_hash: null, attempts: 2 }), maxAttempts: 6 }),
    ).toEqual({ kind: "send", contentChanged: false, superseding: false });
  });

  it("stops retrying once the cap is hit (failure stays logged, no infinite send)", () => {
    expect(
      decideSheetAction({ currentHash: "h1", eligible: true, row: row({ content_hash: "h1", delivered_hash: null, attempts: 6 }), maxAttempts: 6 }),
    ).toEqual({ kind: "done" });
  });
});

describe("windowOpen (18:00 the evening before, UK)", () => {
  it("is closed at 17:00 UK the day before", () => {
    // 2026-07-21 sheet; window opens 2026-07-20 18:00 BST = 17:00 UTC.
    expect(windowOpen("2026-07-21", new Date("2026-07-20T16:59:00Z"))).toBe(false);
  });
  it("is open at 18:00 UK the day before", () => {
    expect(windowOpen("2026-07-21", new Date("2026-07-20T17:00:00Z"))).toBe(true);
  });
  it("is open for a work-date that is already today", () => {
    expect(windowOpen("2026-07-20", new Date("2026-07-20T09:00:00Z"))).toBe(true);
  });
});

describe("targetWorkDates", () => {
  it("returns today and tomorrow in UK time", () => {
    // 23:30 UTC on 20 Jul in BST is 00:30 on 21 Jul UK.
    expect(targetWorkDates(new Date("2026-07-20T23:30:00Z"))).toEqual(["2026-07-21", "2026-07-22"]);
  });
  it("mid-afternoon stays on the same UK day", () => {
    expect(targetWorkDates(new Date("2026-07-20T12:00:00Z"))).toEqual(["2026-07-20", "2026-07-21"]);
  });
});

const dayFixture = (jobs = 2): CrewDaySheet => ({
  crew: { id: "s1", fullName: "Rob Pierce", email: "rob@example.com", phone: "07700900123" },
  workDate: "2026-07-21",
  jobs: Array.from({ length: jobs }, (_, i) => ({
    appointmentId: `a${i}`,
    apptType: "removal",
    window: "09:00–13:00",
    startsAt: "2026-07-21T08:00:00Z",
    sheet: {
      quoteRef: "MMR001",
      customerName: "Jane Doe",
      customerPhone: "07711 111111",
      moveDate: "2026-07-21",
      timeWindow: "09:00–13:00",
      days: 1,
      from: { address: "1 A St", postcode: "SP7 8AA", propertyType: "house", floor: "ground", lift: "no", accessM: 0 },
      to: { address: "2 B St", postcode: "BH1 1BB", propertyType: "flat", floor: "2", lift: "yes", accessM: 20 },
      vehicleLabel: "1 Luton Van",
      packingLabel: "Owner packs",
      crew: ["Rob Pierce"],
      vehicles: ["Luton 1 (AB12 CDE)"],
      items: [{ label: "Large boxes", qty: 10 }],
      accessNotes: "",
      largeItemsNotes: "",
      jobNotes: "",
    },
  })),
});

describe("smsBody", () => {
  it("is a single short line with the link and no placeholders", () => {
    const body = smsBody(dayFixture(2), "https://ops.marleymoves.co.uk/sheet/tok", false);
    expect(body).toContain("https://ops.marleymoves.co.uk/sheet/tok");
    expect(body).toContain("2 jobs");
    expect(body).not.toMatch(/undefined|null|\{\{/);
    expect(body.length).toBeLessThan(200);
  });
  it("marks an update", () => {
    expect(smsBody(dayFixture(1), "u", true)).toContain("UPDATE");
  });
});

describe("emailHtml", () => {
  it("has no unresolved placeholders and links the web sheet", () => {
    const html = emailHtml(dayFixture(2), "https://ops.marleymoves.co.uk/sheet/tok", false);
    expect(html).toContain("https://ops.marleymoves.co.uk/sheet/tok");
    expect(html).toContain("Rob");
    expect(html).not.toMatch(/undefined|\{\{/);
  });
  it("shows the updated banner on a re-send and the no-jobs wording when cleared", () => {
    expect(emailHtml(dayFixture(2), "u", true)).toContain("Updated sheet");
    expect(emailHtml(dayFixture(0), "u", false)).toContain("no jobs");
  });
});
