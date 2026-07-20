import { describe, expect, it } from "vitest";
import { buildDaySheetDocDef } from "@/lib/crew-sheet/daily-docdef";
import { renderPdfBase64 } from "@/lib/pdf/server-pdf";
import type { CrewDaySheet } from "@/lib/crew-sheet/daily-data";

const day = (over: Partial<CrewDaySheet> = {}): CrewDaySheet => ({
  crew: { id: "s1", fullName: "Rob Pierce", email: "rob@x.com", phone: "07700900123" },
  workDate: "2026-07-21",
  jobs: [
    {
      appointmentId: "a1",
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
        accessNotes: "Park on the drive",
        largeItemsNotes: "",
        jobNotes: "Piano — go slow",
        contractSigned: false,
      },
    },
  ],
  ...over,
});

// Deep-search a pdfmake doc-def for any string containing a £ amount.
function allText(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return out;
}

describe("buildDaySheetDocDef", () => {
  it("names the brand font so pdfmake never hangs on an unset font", () => {
    const dd = buildDaySheetDocDef(day(), { version: 1, supersedes: false, generatedAtLabel: "18:00 on Sun 20 Jul" });
    expect(dd.defaultStyle.font).toBe("Montserrat");
  });

  it("carries the crew, customer and access detail the crew needs", () => {
    const text = allText(buildDaySheetDocDef(day(), { version: 1, supersedes: false, generatedAtLabel: "x" })).join(" ");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("07711 111111");
    expect(text).toContain("SP7 8AA");
    expect(text).toContain("Luton 1 (AB12 CDE)");
    expect(text).toContain("Park on the drive");
    expect(text).toMatch(/Contract not yet signed/);
  });

  it("is PRICE-FREE — no £ amount ever reaches a crew sheet", () => {
    const text = allText(buildDaySheetDocDef(day(), { version: 3, supersedes: true, generatedAtLabel: "x" }));
    for (const t of text) expect(t).not.toMatch(/£\s*\d/);
  });

  it("shows a superseding banner only when re-issued", () => {
    const first = allText(buildDaySheetDocDef(day(), { version: 1, supersedes: false, generatedAtLabel: "x" })).join(" ");
    expect(first).not.toMatch(/UPDATED SHEET/);
    const resend = allText(buildDaySheetDocDef(day(), { version: 2, supersedes: true, generatedAtLabel: "18:04 on Sun 20 Jul" })).join(" ");
    expect(resend).toMatch(/UPDATED SHEET \(version 2\)/);
  });

  it("handles a cleared (no-jobs) day", () => {
    const text = allText(buildDaySheetDocDef(day({ jobs: [] }), { version: 2, supersedes: true, generatedAtLabel: "x" })).join(" ");
    expect(text).toContain("No jobs assigned");
  });
});

describe("renderPdfBase64 (server printer)", () => {
  it("renders a real PDF from the day-sheet doc-def", async () => {
    const b64 = await renderPdfBase64(
      buildDaySheetDocDef(day(), { version: 1, supersedes: false, generatedAtLabel: "18:00 on Sun 20 Jul" }),
    );
    const buf = Buffer.from(b64, "base64");
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-"); // valid PDF header
  }, 20_000);
});
