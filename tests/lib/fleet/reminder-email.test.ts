import { describe, expect, it } from "vitest";
import { dueingPhrase, fleetDigestHtml, fleetDigestSubject, type DigestItem } from "@/lib/fleet/reminder-email";

describe("dueingPhrase", () => {
  it("reads due-in for future dates", () => {
    expect(dueingPhrase(7, "2026-07-16")).toBe("due in 7 days (16 Jul 2026)");
    expect(dueingPhrase(1, "2026-07-10")).toBe("due in 1 day (10 Jul 2026)");
  });
  it("reads due-today at zero", () => {
    expect(dueingPhrase(0, "2026-07-09")).toBe("due today (9 Jul 2026)");
  });
  it("reads overdue for past dates", () => {
    expect(dueingPhrase(-8, "2026-07-01")).toBe("overdue by 8 days (was 1 Jul 2026)");
    expect(dueingPhrase(-1, "2026-07-08")).toBe("overdue by 1 day (was 8 Jul 2026)");
  });
});

describe("fleetDigestSubject", () => {
  const item = (over: Partial<DigestItem> = {}): DigestItem => ({
    vehicleName: "Luton 1",
    expiryLabel: "MOT",
    dueDate: "2026-07-16",
    days: 7,
    ...over,
  });

  it("names the single item", () => {
    expect(fleetDigestSubject([item()])).toBe("Fleet reminder: Luton 1 MOT due in 7 days (16 Jul 2026)");
  });
  it("counts multiple items", () => {
    expect(fleetDigestSubject([item(), item({ expiryLabel: "Tax" })])).toBe(
      "Fleet reminders: 2 vehicle documents need attention",
    );
  });
  it("has no em-dashes (internal ops copy, house style)", () => {
    expect(fleetDigestSubject([item({ days: -3, dueDate: "2026-07-06" })])).not.toMatch(/[—–]/);
  });
});

describe("fleetDigestHtml", () => {
  const items: DigestItem[] = [
    { vehicleName: "Luton 1", expiryLabel: "MOT", dueDate: "2026-07-16", days: 7 },
    { vehicleName: "Luton 2", expiryLabel: "Insurance", dueDate: "2026-07-01", days: -8 },
  ];

  it("lists every item with its phrase and links to Staff & Fleet", () => {
    const html = fleetDigestHtml(items);
    expect(html).toContain("Luton 1");
    expect(html).toContain("due in 7 days (16 Jul 2026)");
    expect(html).toContain("Luton 2");
    expect(html).toContain("overdue by 8 days (was 1 Jul 2026)");
    expect(html).toContain("ops.marleymoves.co.uk/resources?tab=vehicles");
  });

  it("escapes vehicle names to prevent HTML injection", () => {
    const html = fleetDigestHtml([{ vehicleName: "<b>x</b>", expiryLabel: "MOT", dueDate: "2026-07-16", days: 7 }]);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
