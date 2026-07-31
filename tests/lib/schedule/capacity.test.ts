import { describe, expect, it } from "vitest";
import {
  dayCapacityState,
  sumRequired,
  needsDriverWarning,
  usableFleetForDay,
  MIN_BOOKED_REQUIREMENT,
  DEFAULT_THRESHOLDS,
  type FleetVehicle,
} from "@/lib/schedule/capacity";

const fleet = { vans: 3, crew: 6 };

/** A road-legal vehicle (no expiry dates set → never auto off-road). */
const van = (id: string): FleetVehicle => ({
  id,
  tax_due: null,
  mot_due: null,
  insurance_renewal: null,
  service_due: null,
  end_of_term: null,
});

describe("dayCapacityState", () => {
  it("is available when a spare van AND crew remain", () => {
    const r = dayCapacityState({ requiredVans: 1, requiredCrew: 2, fleet });
    expect(r).toEqual({ state: "available", freeVans: 2, freeCrew: 4 });
  });

  it("is limited when down to the last of either resource", () => {
    // 2 vans used of 3 -> 1 van free -> limited (default limitedAt = 1)
    expect(dayCapacityState({ requiredVans: 2, requiredCrew: 2, fleet }).state).toBe("limited");
    // crew is the binding axis: 5 crew used of 6 -> 1 free -> limited
    expect(dayCapacityState({ requiredVans: 1, requiredCrew: 5, fleet }).state).toBe("limited");
  });

  it("is full when no spare van OR no spare crew", () => {
    expect(dayCapacityState({ requiredVans: 3, requiredCrew: 2, fleet }).state).toBe("full");
    expect(dayCapacityState({ requiredVans: 1, requiredCrew: 6, fleet }).state).toBe("full");
  });

  it("is over when required exceeds the fleet on either axis", () => {
    const r = dayCapacityState({ requiredVans: 4, requiredCrew: 2, fleet });
    expect(r.state).toBe("over");
    expect(r.freeVans).toBe(-1);
  });

  it("takes the WORST of vans vs crew", () => {
    // vans fine (available), crew over -> whole day reads over
    expect(dayCapacityState({ requiredVans: 1, requiredCrew: 7, fleet }).state).toBe("over");
  });

  it("an empty day is available with the full fleet free", () => {
    expect(dayCapacityState({ requiredVans: 0, requiredCrew: 0, fleet })).toEqual({
      state: "available",
      freeVans: 3,
      freeCrew: 6,
    });
  });

  it("thresholds are configurable — a bigger limitedAt keeps a day green longer", () => {
    // 1 van free would be 'limited' by default...
    expect(dayCapacityState({ requiredVans: 2, requiredCrew: 0, fleet }).state).toBe("limited");
    // ...but with limitedAt lowered to 0 it stays available until genuinely full
    expect(
      dayCapacityState({ requiredVans: 2, requiredCrew: 0, fleet, thresholds: { limitedAt: 0 } }).state,
    ).toBe("available");
  });

  it("default threshold is 1", () => {
    expect(DEFAULT_THRESHOLDS.limitedAt).toBe(1);
  });
});

describe("sumRequired", () => {
  it("sums vans and crew across a day's jobs", () => {
    expect(
      sumRequired([
        { requiredVans: 2, requiredCrew: 4 },
        { requiredVans: 1, requiredCrew: 2 },
      ]),
    ).toEqual({ requiredVans: 3, requiredCrew: 6 });
  });

  it("a crew-only pack job (0 vans) still adds crew", () => {
    expect(sumRequired([{ requiredVans: 0, requiredCrew: 2 }])).toEqual({ requiredVans: 0, requiredCrew: 2 });
  });

  it("empty day sums to zero", () => {
    expect(sumRequired([])).toEqual({ requiredVans: 0, requiredCrew: 0 });
  });
});

describe("usableFleetForDay", () => {
  const day = "2026-08-05";
  const vehicles = [van("v1"), van("v2")];

  it("counts crew working that day and all road-legal vans", () => {
    // working_days = every day → available regardless of the calendar weekday.
    const staff = [
      { id: "s1", working_days: [1, 2, 3, 4, 5, 6, 7] },
      { id: "s2", working_days: [1, 2, 3, 4, 5, 6, 7] },
    ];
    expect(
      usableFleetForDay({ day, staff, vehicles, availByStaff: new Map(), unavailByVehicle: new Map() }),
    ).toEqual({ vans: 2, crew: 2 });
  });

  it("drops crew who don't work that day — the weekend bug: 0 usable crew, not the full headcount", () => {
    // No set working days → off every day unless an explicit override says otherwise.
    const staff = [
      { id: "s1", working_days: [] },
      { id: "s2", working_days: [] },
    ];
    const r = usableFleetForDay({ day, staff, vehicles, availByStaff: new Map(), unavailByVehicle: new Map() });
    expect(r.crew).toBe(0); // matches the Job Board's 0 crew on a non-working day
    expect(r.vans).toBe(2); // vans are unaffected by the crew pattern
  });

  it("a per-date 'available' override brings an off-pattern crew member back", () => {
    const staff = [{ id: "s1", working_days: [] }];
    const availByStaff = new Map([[
      "s1",
      [{ date: day, status: "available" as const, note: null }],
    ]]);
    expect(
      usableFleetForDay({ day, staff, vehicles: [], availByStaff, unavailByVehicle: new Map() }).crew,
    ).toBe(1);
  });

  it("drops a van inside an off-road window", () => {
    const unavailByVehicle = new Map([[
      "v1",
      [{ start_date: day, end_date: day, reason: "repair" }],
    ]]);
    const r = usableFleetForDay({ day, staff: [], vehicles, availByStaff: new Map(), unavailByVehicle });
    expect(r.vans).toBe(1); // v1 off the road, v2 still usable
  });
});

describe("MIN_BOOKED_REQUIREMENT", () => {
  it("floors a booked-but-unpriced removal at a van and a two-person crew (never zero)", () => {
    expect(MIN_BOOKED_REQUIREMENT).toEqual({ requiredVans: 1, requiredCrew: 2 });
  });

  it("keeps a day carrying one unpriced booked move from grading as sellable-empty", () => {
    // One committed move, a fleet of exactly a van + two crew → everything is committed.
    const graded = dayCapacityState({
      ...sumRequired([MIN_BOOKED_REQUIREMENT]),
      fleet: { vans: 1, crew: 2 },
    });
    expect(graded.state).toBe("full");
    expect(graded).toMatchObject({ freeVans: 0, freeCrew: 0 });
  });
});

describe("needsDriverWarning", () => {
  it("warns when a van is assigned but no driver is on the crew", () => {
    expect(needsDriverWarning({ assignedVans: 1, assignedDrivers: 0 })).toBe(true);
  });
  it("no warning when at least one driver is assigned", () => {
    expect(needsDriverWarning({ assignedVans: 2, assignedDrivers: 1 })).toBe(false);
  });
  it("no warning when there is no van to drive", () => {
    expect(needsDriverWarning({ assignedVans: 0, assignedDrivers: 0 })).toBe(false);
  });
});
