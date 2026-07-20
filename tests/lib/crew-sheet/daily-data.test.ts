import { describe, expect, it } from "vitest";
import { assembleDaySheets, daySheetHash, type CrewDaySheet } from "@/lib/crew-sheet/daily-data";

/* A minimal fake of the admin client: every query method chains and the object
 * is awaitable, resolving to the canned rows for its table (filters ignored —
 * the assembly logic under test does the grouping, not the DB). */
function fakeAdmin(byTable: Record<string, unknown[]>) {
  const make = (table: string) => {
    const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const m of ["select", "eq", "neq", "in", "gte", "lt", "order", "limit", "maybeSingle"]) {
      q[m] = () => q;
    }
    q.then = (resolve: (v: { data: unknown[] }) => void) => resolve({ data: byTable[table] ?? [] });
    return q;
  };
  return { from: (t: string) => make(t) };
}

const APPT = {
  id: "a1",
  title: "Job",
  starts_at: "2026-07-21T08:00:00Z",
  ends_at: "2026-07-21T12:00:00Z",
  all_day: false,
  appt_type: "removal",
  lead_id: "L1",
  status: "scheduled",
};
const LEAD = {
  id: "L1",
  name: "Jane Doe",
  phone: "07711 111111",
  from_address: "1 A St",
  from_postcode: "sp7 8aa",
  to_address: "2 B St",
  to_postcode: "bh1 1bb",
  notes: "Ring the buzzer",
};

describe("assembleDaySheets", () => {
  it("groups a shared job under every assigned active crew member", async () => {
    const admin = fakeAdmin({
      appointments: [APPT],
      appointment_assignments: [
        { appointment_id: "a1", staff_id: "s1", vehicle_id: "v1" },
        { appointment_id: "a1", staff_id: "s2", vehicle_id: null },
      ],
      leads: [LEAD],
      quotes: [],
      surveys: [{ id: "sv1", lead_id: "L1", created_at: "2026-07-10T00:00:00Z" }],
      staff: [
        { id: "s1", full_name: "Rob Pierce", email: "rob@x.com", phone: "07700900123", is_active: true },
        { id: "s2", full_name: "Oscar Small", email: null, phone: null, is_active: true },
      ],
      vehicles: [{ id: "v1", name: "Luton 1", registration: "AB12 CDE" }],
    });

    const sheets = await assembleDaySheets(admin as never, "2026-07-21");
    expect(sheets).toHaveLength(2);
    // Sorted by crew name → Oscar before Rob.
    expect(sheets.map((s) => s.crew.fullName)).toEqual(["Oscar Small", "Rob Pierce"]);

    const rob = sheets.find((s) => s.crew.id === "s1")!;
    expect(rob.jobs).toHaveLength(1);
    const job = rob.jobs[0];
    expect(job.sheet.customerName).toBe("Jane Doe");
    expect(job.sheet.customerPhone).toBe("07711 111111");
    expect(job.sheet.from.postcode).toBe("SP7 8AA"); // upper-cased
    expect(job.sheet.crew).toEqual(["Oscar Small", "Rob Pierce"]); // both crew mates, sorted
    expect(job.sheet.vehicles).toEqual(["Luton 1 (AB12 CDE)"]);
    expect(job.window).toBe("09:00–13:00"); // 08:00Z in BST
    expect(job.surveyId).toBe("sv1"); // latest survey threaded for photo loading
  });

  it("drops an inactive crew member and jobs off the target day", async () => {
    const admin = fakeAdmin({
      appointments: [
        APPT,
        { ...APPT, id: "a2", starts_at: "2026-07-25T08:00:00Z", ends_at: "2026-07-25T12:00:00Z" },
      ],
      appointment_assignments: [
        { appointment_id: "a1", staff_id: "s1", vehicle_id: null },
        { appointment_id: "a1", staff_id: "s3", vehicle_id: null }, // inactive
        { appointment_id: "a2", staff_id: "s1", vehicle_id: null }, // different day
      ],
      leads: [LEAD],
      quotes: [],
      staff: [
        { id: "s1", full_name: "Rob Pierce", email: "rob@x.com", phone: null, is_active: true },
        { id: "s3", full_name: "Ghost", email: null, phone: null, is_active: false },
      ],
      vehicles: [],
    });

    const sheets = await assembleDaySheets(admin as never, "2026-07-21");
    expect(sheets.map((s) => s.crew.fullName)).toEqual(["Rob Pierce"]);
    expect(sheets[0].jobs.map((j) => j.appointmentId)).toEqual(["a1"]); // a2 (25 Jul) excluded
  });

  it("returns nothing when no appointments touch the day", async () => {
    const admin = fakeAdmin({ appointments: [] });
    expect(await assembleDaySheets(admin as never, "2026-07-21")).toEqual([]);
  });
});

describe("daySheetHash", () => {
  const base: CrewDaySheet = {
    crew: { id: "s1", fullName: "Rob", email: null, phone: null },
    workDate: "2026-07-21",
    jobs: [
      {
        appointmentId: "a1",
        apptType: "removal",
        window: "09:00–13:00",
        startsAt: "2026-07-21T08:00:00Z",
        surveyId: null,
        sheet: {
          quoteRef: "MMR001",
          customerName: "Jane",
          customerPhone: "07711",
          moveDate: "2026-07-21",
          timeWindow: "09:00–13:00",
          days: 1,
          from: { address: "1 A St", postcode: "SP7", propertyType: "house", floor: "ground", lift: "no", accessM: 0 },
          to: { address: "2 B St", postcode: "BH1", propertyType: "flat", floor: "2", lift: "yes", accessM: 20 },
          vehicleLabel: "1 Luton Van",
          packingLabel: "Owner packs",
          crew: ["Rob"],
          vehicles: ["Luton 1"],
          items: [{ label: "Boxes", qty: 10 }],
          accessNotes: "",
          largeItemsNotes: "",
          jobNotes: "",
        },
      },
    ],
  };

  it("is stable for identical content", () => {
    expect(daySheetHash(base)).toBe(daySheetHash(structuredClone(base)));
  });

  it("changes when a customer-visible field changes (time, address, crew, notes)", () => {
    const h0 = daySheetHash(base);
    const changedTime = structuredClone(base);
    changedTime.jobs[0].window = "10:00–14:00";
    expect(daySheetHash(changedTime)).not.toBe(h0);

    const changedCrew = structuredClone(base);
    changedCrew.jobs[0].sheet.crew = ["Rob", "Oscar"];
    expect(daySheetHash(changedCrew)).not.toBe(h0);

    const changedNotes = structuredClone(base);
    changedNotes.jobs[0].sheet.jobNotes = "Careful with the piano";
    expect(daySheetHash(changedNotes)).not.toBe(h0);
  });

  it("changes when a job is added or removed", () => {
    const h0 = daySheetHash(base);
    const empty = structuredClone(base);
    empty.jobs = [];
    expect(daySheetHash(empty)).not.toBe(h0);
  });
});
