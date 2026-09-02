import { describe, expect, it, vi, afterEach } from "vitest";
import { assembleDaySheets } from "@/lib/crew-sheet/daily-data";

/**
 * The day sheet's brand markers are how crew tell a Pitmans job from a Marley
 * one on a MIXED day (multi-brand PRD §3.6). The brands read used to be
 * fail-soft-to-nothing: a failed read yielded an empty short-name map, every
 * job's brandShort came back null, and the doc-def — seeing one distinct
 * (absent) brand — rendered no markers at all. Crew then worked a mixed day
 * with no brand signal, and nothing anywhere said the read had failed: the
 * "I could not check" rule's exact shape.
 *
 * Now: a failed brands read on a day whose jobs span >1 brand REFUSES loudly
 * (the cron retries; a missing sheet is visible, a silently unmarked one is
 * not). On a single-brand day markers would not render anyway, so the run
 * degrades — but says so on the console instead of pretending it checked.
 */

/* Same minimal awaitable-chain fake as daily-data.test.ts, extended so a
 * table can resolve with an error instead of rows. */
function fakeAdmin(
  byTable: Record<string, unknown[]>,
  errors: Record<string, { message: string }> = {},
) {
  const make = (table: string) => {
    const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const m of ["select", "eq", "neq", "in", "gte", "lt", "order", "limit", "maybeSingle"]) {
      q[m] = () => q;
    }
    q.then = (resolve: (v: { data: unknown[] | null; error?: { message: string } }) => void) =>
      resolve(errors[table] ? { data: null, error: errors[table] } : { data: byTable[table] ?? [] });
    return q;
  };
  return { from: (t: string) => make(t) };
}

const appt = (id: string, brand: string) => ({
  id,
  title: "Job",
  starts_at: "2026-07-21T08:00:00Z",
  ends_at: "2026-07-21T12:00:00Z",
  all_day: false,
  appt_type: "removal",
  lead_id: null,
  status: "scheduled",
  brand,
});

const CREW = [{ id: "s1", full_name: "Rob Pierce", email: "rob@x.com", phone: null, is_active: true }];
const assigns = (ids: string[]) => ids.map((id) => ({ appointment_id: id, staff_id: "s1", vehicle_id: null }));

afterEach(() => vi.restoreAllMocks());

describe("assembleDaySheets when the brands read fails", () => {
  it("refuses loudly on a mixed-brand day rather than dropping the markers", async () => {
    const admin = fakeAdmin(
      {
        appointments: [appt("a1", "marley"), appt("a2", "pitmans")],
        appointment_assignments: assigns(["a1", "a2"]),
        staff: CREW,
      },
      { brands: { message: "permission denied" } },
    );
    await expect(assembleDaySheets(admin as never, "2026-07-21")).rejects.toThrow(/brands read failed/i);
  });

  it("degrades with a visible note on a single-brand day (markers would not render anyway)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = fakeAdmin(
      {
        appointments: [appt("a1", "marley"), appt("a2", "marley")],
        appointment_assignments: assigns(["a1", "a2"]),
        staff: CREW,
      },
      { brands: { message: "permission denied" } },
    );
    const sheets = await assembleDaySheets(admin as never, "2026-07-21");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].jobs.map((j) => j.brandShort)).toEqual([null, null]);
    expect(err, "the degrade must be SAID, not silent").toHaveBeenCalled();
  });

  it("still threads short names through when the read succeeds", async () => {
    const admin = fakeAdmin({
      appointments: [appt("a1", "marley"), appt("a2", "pitmans")],
      appointment_assignments: assigns(["a1", "a2"]),
      staff: CREW,
      brands: [
        { slug: "marley", short_name: "Marley" },
        { slug: "pitmans", short_name: "Pitmans" },
      ],
    });
    const sheets = await assembleDaySheets(admin as never, "2026-07-21");
    expect(sheets[0].jobs.map((j) => j.brandShort).sort()).toEqual(["Marley", "Pitmans"]);
  });
});
