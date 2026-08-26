import { describe, expect, it } from "vitest";
import { accessLine, assembleJobSheetData, vehicleLabelOf } from "@/lib/job-sheet-data";
import { buildJobSheetDocDef } from "@/lib/job-sheet-docdef";
import { defaultQuoteValues } from "@/lib/quote/form-types";

const appt = {
  id: "a1",
  title: "Removal — Jane Doe",
  starts_at: "2026-07-15T08:00:00+01:00",
  ends_at: "2026-07-15T17:00:00+01:00",
  all_day: true,
};

const lead = {
  name: "Jane Doe",
  phone: "07572 000000",
  from_address: "1 High Street, Gillingham",
  from_postcode: "sp8 4gh",
  to_address: "2 Low Road, Poole",
  to_postcode: "BH1 4DQ",
  notes: "Gate code 4321",
};

function blob() {
  const v = defaultQuoteValues();
  v.customer = { name: "Jane Doe", phone: "07572 000000", email: "" };
  v.job.collectAddr = "1 High Street, Gillingham, SP8 4GH";
  v.job.days = 2;
  v.vehicle = "2luton";
  v.sevenFiveT = 1;
  v.packing = "full";
  v.collect = { type: "flat", lift: "no", floor: "2nd", accessM: 25 };
  v.items.wardrobeBoxes = 6;
  v.items.mattressDouble = 2;
  v.survey.accessNotes = "Narrow lane, park on the corner";
  v.review.quoteNotes = "Piano in the lounge";
  return v;
}

describe("vehicleLabelOf", () => {
  it("describes the vehicle mix in crew language", () => {
    const v = defaultQuoteValues();
    expect(vehicleLabelOf(v)).toBe("1 Luton Van");
    v.vehicle = "3luton";
    v.sevenFiveT = 1;
    v.transitVans = 2;
    expect(vehicleLabelOf(v)).toBe("3 Luton Vans + 1 × 7.5t Lorry + 2 Transit Vans");
    v.vehicle = "transit";
    v.sevenFiveT = 0;
    v.transitVans = 0;
    expect(vehicleLabelOf(v)).toBe("1 Transit Van");
  });
});

describe("assembleJobSheetData", () => {
  it("merges lead, quote and assignments into the crew brief", () => {
    const quote = { quote_ref: "MM-260710-001", moving_date: "2026-07-15", state_blob: blob() };
    const d = assembleJobSheetData(appt, lead, quote, ["Jack", "Oscar"], ["Luton 1 (AB12 CDE)"]);
    expect(d.customerName).toBe("Jane Doe");
    expect(d.quoteRef).toBe("MM-260710-001");
    expect(d.timeWindow).toBe("All day");
    expect(d.days).toBe(2);
    expect(d.from.address).toContain("1 High Street");
    expect(d.from.postcode).toBe("SP8 4GH"); // lead's lowercase postcode upper-cased
    expect(d.from.propertyType).toBe("flat");
    expect(d.from.accessM).toBe(25);
    expect(d.vehicleLabel).toBe("2 Luton Vans + 1 × 7.5t Lorry");
    expect(d.packingLabel).toBe("Full pack service");
    expect(d.items).toEqual([
      { label: "Wardrobe Boxes", qty: 6 },
      { label: "Mattress Covers (Double)", qty: 2 },
    ]);
    expect(d.accessNotes).toBe("Narrow lane, park on the corner");
    expect(d.jobNotes).toBe("Piano in the lounge");
    expect(d.crew).toEqual(["Jack", "Oscar"]);
  });

  it("survives a job with no quote — falls back to the lead", () => {
    const d = assembleJobSheetData(appt, lead, null, [], []);
    expect(d.customerName).toBe("Jane Doe");
    expect(d.moveDate).toBe("2026-07-15"); // from the appointment
    expect(d.items).toEqual([]);
    expect(d.jobNotes).toBe("Gate code 4321"); // lead notes fill in
    expect(d.to.postcode).toBe("BH1 4DQ");
    // QA-20260821-03: no quote → no labels. "See quote" as the packing
    // fallback rendered as the Vehicles card's subtitle on /my-jobs/[id].
    expect(d.vehicleLabel).toBe("");
    expect(d.packingLabel).toBe("");
  });

  it("quoteNotes is quote-only — never the lead fallback jobNotes carries", () => {
    // The diary summary shows enquiry notes separately, so a lead note leaking
    // in under a "Quote notes" label would be the same two-hats bug again.
    const quote = { quote_ref: "MM-260710-001", moving_date: "2026-07-15", state_blob: blob() };
    expect(assembleJobSheetData(appt, lead, quote, [], []).quoteNotes).toBe("Piano in the lounge");
    const bare = assembleJobSheetData(appt, lead, null, [], []);
    expect(bare.jobNotes).toBe("Gate code 4321");
    expect(bare.quoteNotes).toBe("");
  });
});

describe("accessLine", () => {
  it("reads a flat above ground with lift state and carry distance", () => {
    expect(accessLine({ address: "", postcode: "", propertyType: "flat", floor: "2nd", lift: "no", accessM: 25 })).toBe(
      "Flat · 2nd floor · no lift · ~25m carry",
    );
    expect(accessLine({ address: "", postcode: "", propertyType: "flat", floor: "1st", lift: "yes", accessM: 0 })).toBe(
      "Flat · 1st floor · lift",
    );
  });

  it("a ground-floor property never mentions the lift", () => {
    expect(accessLine({ address: "", postcode: "", propertyType: "house", floor: "ground", lift: "no", accessM: 5 })).toBe(
      "House · ground floor · ~5m carry",
    );
  });

  it("no access details at all reads as empty, not a bare carry line", () => {
    expect(accessLine({ address: "", postcode: "", propertyType: "", floor: "ground", lift: "no", accessM: 0 })).toBe("");
  });
});

describe("buildJobSheetDocDef", () => {
  const data = assembleJobSheetData(
    appt,
    lead,
    { quote_ref: "MM-260710-001", moving_date: "2026-07-15", state_blob: blob() },
    ["Jack"],
    ["Luton 1 (AB12 CDE)"],
  );

  it("carries the crew-critical strings", () => {
    const s = JSON.stringify(buildJobSheetDocDef(data));
    for (const expected of [
      "JOB SHEET",
      "Jane Doe",
      "Wednesday, 15 July 2026",
      "SP8 4GH",
      "BH1 4DQ",
      "Wardrobe Boxes",
      "Narrow lane, park on the corner",
      "Piano in the lounge",
      "Jack",
      "Luton 1 (AB12 CDE)",
      "CUSTOMER SIGN-OFF",
    ]) {
      expect(s).toContain(expected);
    }
  });

  it("names a vfs font — an unset font (pdfmake's Roboto default) hangs createPdf", () => {
    const def = buildJobSheetDocDef(data);
    expect(def.defaultStyle.font).toBe("Montserrat");
  });

  it("no brand renders today's default-brand identity — the byte-parity contract", () => {
    const s = JSON.stringify(buildJobSheetDocDef(data));
    expect(s).toContain("MARLEY ");
    expect(s).toContain("#C03838");
    const footer = JSON.stringify(buildJobSheetDocDef(data).footer(1, 1));
    expect(footer).toContain("Marley Moves · 01747 637070 · hello@marleymoves.co.uk");
  });

  it("a brand substitutes its identity, group disclosure, colour and derived tints (PRD §3.6)", () => {
    const branded = {
      ...data,
      brand: {
        slug: "pitmans",
        name: "Pitmans Removals & Storage",
        shortName: "Pitmans",
        groupLine: "Part of the Marley Group",
        legalLine: "MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266",
        phone: "01258 000000",
        email: "info@example.co.uk",
        websiteUrl: null,
        colour: "#2B2B76",
      },
    };
    const def = buildJobSheetDocDef(branded);
    const s = JSON.stringify(def);
    expect(s).toContain("PITMANS REMOVALS & STORAGE");
    expect(s).toContain("Part of the Marley Group");
    expect(s).toContain("#2B2B76");
    // Soft fills and on-dark subtext are TINTS of the brand colour, not the
    // default brand's hardcoded pinks.
    expect(s).toContain("#f2f2f7");
    expect(def.styles.heroSub.color).toBe("#d7d7e5");
    expect(s).not.toContain("#C03838");
    expect(s).not.toContain("#FDF1F1");
    expect(s).not.toContain("#F4D9D9");
    expect(s).not.toContain("MARLEY ");
    const footer = JSON.stringify(def.footer(1, 1));
    expect(footer).toContain("Pitmans Removals & Storage · 01258 000000 · info@example.co.uk");
    expect(footer).not.toContain("Marley");
  });

  it("NEVER leaks money — the crew sheet is price-free", () => {
    const s = JSON.stringify(buildJobSheetDocDef(data));
    expect(s).not.toContain("£");
    expect(s.toLowerCase()).not.toContain("deposit");
    expect(s.toLowerCase()).not.toContain("total");
  });

  it("empty assignment lists render the check-the-board hint", () => {
    const bare = assembleJobSheetData(appt, lead, null, [], []);
    const s = JSON.stringify(buildJobSheetDocDef(bare));
    expect(s).toContain("No crew assigned yet");
    expect(s).toContain("No vehicles assigned yet");
  });

  it("no-quote job spec line is empty — no placeholder text, no dangling separator", () => {
    const bare = assembleJobSheetData(appt, lead, null, [], []);
    const s = JSON.stringify(buildJobSheetDocDef(bare));
    expect(s).not.toContain("See quote");
    expect(s).not.toContain("  ·  "); // the spec-line join never leaks half-empty
    // and with a quote the spec line still reads vehicle · packing
    expect(JSON.stringify(buildJobSheetDocDef(data))).toContain("2 Luton Vans + 1 × 7.5t Lorry  ·  Full pack service");
  });

  it("survey photos render on their own page with category captions", () => {
    const withPhotos = {
      ...data,
      photos: [
        { dataUri: "data:image/jpeg;base64,AAA", label: "Access", caption: "Narrow gate" },
        { dataUri: "data:image/jpeg;base64,BBB", label: "Large items / extra packing", caption: "" },
        { dataUri: "data:image/jpeg;base64,CCC", label: "Access", caption: "" },
      ],
    };
    const s = JSON.stringify(buildJobSheetDocDef(withPhotos));
    expect(s).toContain("SURVEY PHOTOS");
    expect(s).toContain("data:image/jpeg;base64,AAA");
    expect(s).toContain("Access — Narrow gate");
    expect(s).toContain('"pageBreak":"before"');
    // and without photos the section vanishes entirely
    expect(JSON.stringify(buildJobSheetDocDef(data))).not.toContain("SURVEY PHOTOS");
  });

  it("renders the room-grouped survey inventory and flags NOT MOVING — staying price-free", () => {
    const withSurvey = {
      ...data,
      surveyInventory: [
        {
          room: "Lounge",
          items: [
            { title: "Sofa 2 seater", qty: 2, ft3: 70, flags: { dismantle: false, fragile: true, notMoving: false } },
            { title: "Chest freezer", qty: 1, ft3: 45, flags: { dismantle: false, fragile: false, notMoving: true }, note: "Customer keeps it" },
          ],
        },
        {
          room: "General",
          items: [{ title: "Odd box", qty: 1, ft3: 5, flags: { dismantle: false, fragile: false, notMoving: false } }],
        },
      ],
    };
    const s = JSON.stringify(buildJobSheetDocDef(withSurvey));
    expect(s).toContain("SURVEY INVENTORY");
    expect(s).toContain("Sofa 2 seater");
    expect(s).toContain("Chest freezer");
    expect(s).toContain("Lounge");
    expect(s).toContain("NOT MOVING — leave in place");
    expect(s).toContain("Customer keeps it");
    // still price-free with the survey block present
    expect(s).not.toContain("£");
    expect(s.toLowerCase()).not.toContain("deposit");
    // and no survey block when there's no inventory
    expect(JSON.stringify(buildJobSheetDocDef(data))).not.toContain("SURVEY INVENTORY");
  });

  it("shows a QR to the job page when the survey has walkthrough videos; hidden otherwise", () => {
    const jobUrl = "https://ops.marleymoves.co.uk/my-jobs/abc-123";
    const withVideos = JSON.stringify(buildJobSheetDocDef({ ...data, videoCount: 2, jobUrl }));
    expect(withVideos).toContain("SURVEY WALKTHROUGH VIDEOS");
    expect(withVideos).toContain(`"qr":"${jobUrl}"`);
    expect(withVideos).toContain("2 videos on file");
    // no count, or no url → no QR block
    expect(JSON.stringify(buildJobSheetDocDef({ ...data, videoCount: 0, jobUrl }))).not.toContain("SURVEY WALKTHROUGH VIDEOS");
    expect(JSON.stringify(buildJobSheetDocDef({ ...data, videoCount: 2, jobUrl: null }))).not.toContain("SURVEY WALKTHROUGH VIDEOS");
  });

  it("unsigned contract prints the collect-on-arrival banner; signed/no-quote stays clean", () => {
    const flagged = JSON.stringify(buildJobSheetDocDef({ ...data, contractSigned: false }));
    expect(flagged).toContain("CONTRACT NOT YET SIGNED");
    expect(JSON.stringify(buildJobSheetDocDef({ ...data, contractSigned: true }))).not.toContain(
      "CONTRACT NOT YET SIGNED",
    );
    expect(JSON.stringify(buildJobSheetDocDef({ ...data, contractSigned: null }))).not.toContain(
      "CONTRACT NOT YET SIGNED",
    );
  });

  it("no-quote inventory keeps the colSpan filler a BARE {} — any property loops pdfmake's layout", () => {
    const bare = assembleJobSheetData(appt, lead, null, [], []);
    const def = buildJobSheetDocDef(bare);
    const tables = def.content.filter((b: { table?: { body: unknown[][] } }) => b.table);
    const inventory = tables.find((b: { table: { body: { text?: string }[][] } }) =>
      JSON.stringify(b).includes("No packing materials"),
    );
    const emptyRow = inventory.table.body[1];
    expect(emptyRow[0].colSpan).toBe(2);
    expect(Object.keys(emptyRow[1])).toEqual([]);
  });
});

/**
 * QA-20260822-01: moveDate preferred the accepted quote's `moving_date` over the
 * appointment's own `starts_at` whenever a quote existed, so /my-jobs/[id], the
 * Job Sheet PDF and the emailed/SMS'd crew day-sheet (all three share
 * assembleJobSheetData) named a STALE day whenever the two diverged — while the
 * /my-jobs LIST, a separate path keyed purely on starts_at, showed the real one.
 * Crew could be told the wrong day for their own job.
 */
describe("assembleJobSheetData moveDate — the live diary slot wins", () => {
  const q = (moving_date: string | null) => ({ quote_ref: "MM-260710-001", moving_date, state_blob: blob() });

  it("uses the appointment's date when the quote's has gone stale", () => {
    // The exact shape the audit reproduced live: appointment moved, quote not rolled forward.
    const moved = { ...appt, starts_at: "2026-08-23T09:00:00Z", ends_at: "2026-08-23T17:00:00Z" };
    const d = assembleJobSheetData(moved, lead, q("2026-09-05"), [], []);
    expect(d.moveDate).toBe("2026-08-23");
  });

  it("agrees with the quote when nothing has drifted", () => {
    const d = assembleJobSheetData(appt, lead, q("2026-07-15"), [], []);
    expect(d.moveDate).toBe("2026-07-15");
  });

  it("falls back to the quote only when the appointment has no date at all", () => {
    const undated = { ...appt, starts_at: null as unknown as string };
    expect(assembleJobSheetData(undated, lead, q("2026-09-05"), [], []).moveDate).toBe("2026-09-05");
  });

  it("takes the UK calendar day, not the UTC one, through BST", () => {
    // 23:30Z on 23 Aug is already 00:30 on the 24th in London. A `.slice(0, 10)`
    // would say the 23rd and disagree with the /my-jobs list, which buckets by
    // Europe/London — the very disagreement this finding is about.
    const lateNight = { ...appt, starts_at: "2026-08-23T23:30:00Z", ends_at: "2026-08-24T03:00:00Z" };
    expect(assembleJobSheetData(lateNight, lead, q("2026-09-05"), [], []).moveDate).toBe("2026-08-24");
  });
});
