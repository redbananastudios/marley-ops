import { describe, expect, it } from "vitest";
import {
  dayCapacityState,
  sumRequired,
  needsDriverWarning,
  DEFAULT_THRESHOLDS,
} from "@/lib/schedule/capacity";

const fleet = { vans: 3, crew: 6 };

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
