import { describe, expect, it } from "vitest";
import { vehicleOffRoad, type UnavailabilityWindow } from "@/lib/fleet/availability";
import type { VehicleExpiryDates } from "@/lib/vehicles";

const DAY = "2026-07-09";
const clear: VehicleExpiryDates = {
  tax_due: null,
  mot_due: null,
  insurance_renewal: null,
  service_due: null,
  end_of_term: null,
};
const win = (start: string, end: string, reason: string): UnavailabilityWindow => ({
  start_date: start,
  end_date: end,
  reason,
});

describe("vehicleOffRoad", () => {
  it("is on the road with nothing set", () => {
    expect(vehicleOffRoad(clear, [], DAY)).toEqual({ offRoad: false, reason: null });
  });

  it("is off-road inside an unavailability window, labelled by reason", () => {
    expect(vehicleOffRoad(clear, [win("2026-07-08", "2026-07-10", "service")], DAY)).toEqual({
      offRoad: true,
      reason: "Service booked",
    });
    expect(vehicleOffRoad(clear, [win("2026-07-09", "2026-07-09", "repair")], DAY).reason).toBe("In for repair");
  });

  it("window boundaries are inclusive; days outside are clear", () => {
    expect(vehicleOffRoad(clear, [win("2026-07-09", "2026-07-12", "mot")], "2026-07-09").offRoad).toBe(true);
    expect(vehicleOffRoad(clear, [win("2026-07-05", "2026-07-09", "mot")], "2026-07-09").offRoad).toBe(true);
    expect(vehicleOffRoad(clear, [win("2026-07-05", "2026-07-08", "mot")], "2026-07-09").offRoad).toBe(false);
  });

  it("is off-road when a legal doc is overdue as of the day", () => {
    expect(vehicleOffRoad({ ...clear, mot_due: "2026-07-01" }, [], DAY)).toEqual({
      offRoad: true,
      reason: "MOT overdue",
    });
    expect(vehicleOffRoad({ ...clear, insurance_renewal: "2026-07-08" }, [], DAY).reason).toBe("Insurance overdue");
  });

  it("does NOT off-road for an overdue Service or Lease (reminder-only)", () => {
    expect(vehicleOffRoad({ ...clear, service_due: "2026-07-01" }, [], DAY).offRoad).toBe(false);
    expect(vehicleOffRoad({ ...clear, end_of_term: "2026-07-01" }, [], DAY).offRoad).toBe(false);
  });

  it("a doc still in date does not off-road", () => {
    expect(vehicleOffRoad({ ...clear, mot_due: "2026-12-01" }, [], DAY).offRoad).toBe(false);
  });

  it("a covering window wins the reason over an overdue doc", () => {
    const res = vehicleOffRoad({ ...clear, mot_due: "2026-07-01" }, [win("2026-07-08", "2026-07-10", "repair")], DAY);
    expect(res).toEqual({ offRoad: true, reason: "In for repair" });
  });
});
