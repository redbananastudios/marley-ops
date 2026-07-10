import { describe, expect, it } from "vitest";
import { defaultCuft, letIsOpen, occupiedUnitIds, siteOccupancy } from "@/lib/storage-units";

describe("defaultCuft", () => {
  it("auto-fills the known container sizes", () => {
    expect(defaultCuft("crate_250")).toBe(250);
    expect(defaultCuft("container_20ft")).toBe(1170);
    expect(defaultCuft("container_40ft")).toBe(2390);
  });

  it("returns null when the type has no preset size", () => {
    expect(defaultCuft("room")).toBeNull();
    expect(defaultCuft("other")).toBeNull();
    expect(defaultCuft("bogus")).toBeNull();
  });
});

describe("letIsOpen", () => {
  it("is open only while end_date is null", () => {
    expect(letIsOpen({ end_date: null })).toBe(true);
    expect(letIsOpen({ end_date: "2026-07-01" })).toBe(false);
  });
});

describe("occupiedUnitIds", () => {
  it("collects units with an open let and ignores closed lets", () => {
    const ids = occupiedUnitIds([
      { unit_id: "u1", end_date: null },
      { unit_id: "u2", end_date: "2026-06-30" },
      { unit_id: "u3", end_date: null },
    ]);
    expect(ids.has("u1")).toBe(true);
    expect(ids.has("u2")).toBe(false);
    expect(ids.has("u3")).toBe(true);
  });
});

describe("siteOccupancy", () => {
  const units = [
    { id: "u1", site_id: "s1", is_active: true },
    { id: "u2", site_id: "s1", is_active: true },
    { id: "u3", site_id: "s1", is_active: false }, // archived — never counted
    { id: "u4", site_id: "s2", is_active: true },
  ];

  it("counts only the site's active units", () => {
    const occ = siteOccupancy(units, [{ unit_id: "u1", end_date: null }], "s1");
    expect(occ).toEqual({ total: 2, occupied: 1, available: 1 });
  });

  it("an open let on an archived unit does not distort the site numbers", () => {
    const occ = siteOccupancy(units, [{ unit_id: "u3", end_date: null }], "s1");
    expect(occ).toEqual({ total: 2, occupied: 0, available: 2 });
  });

  it("other sites' lets are invisible", () => {
    const occ = siteOccupancy(units, [{ unit_id: "u4", end_date: null }], "s1");
    expect(occ).toEqual({ total: 2, occupied: 0, available: 2 });
  });

  it("fully occupied site reports zero available", () => {
    const occ = siteOccupancy(
      units,
      [
        { unit_id: "u1", end_date: null },
        { unit_id: "u2", end_date: null },
      ],
      "s1",
    );
    expect(occ).toEqual({ total: 2, occupied: 2, available: 0 });
  });
});
