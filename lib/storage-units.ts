/**
 * Storage helpers — sites hold units, units hold lets, and occupancy is
 * DERIVED from lets: a unit is occupied while it has a let whose end_date is
 * null. Nothing stores an "occupied" flag (iMVE derives it the same way), so
 * status can never drift from the let history.
 */

export const UNIT_TYPES = [
  { value: "crate_250", label: "250 cu ft crate", cuft: 250 },
  { value: "container_20ft", label: "20ft container", cuft: 1170 },
  { value: "container_40ft", label: "40ft container", cuft: 2390 },
  { value: "room", label: "Storage room", cuft: null },
  { value: "other", label: "Other", cuft: null },
] as const;

export type UnitType = (typeof UNIT_TYPES)[number]["value"];

/** Default cubic-feet for a unit type (dialog auto-fill; null = enter manually). */
export function defaultCuft(type: string): number | null {
  return UNIT_TYPES.find((t) => t.value === type)?.cuft ?? null;
}

export interface OpenLetLite {
  unit_id: string;
  end_date: string | null;
}

/** A let counts as open while it has no end date. */
export function letIsOpen(l: { end_date: string | null }): boolean {
  return l.end_date == null;
}

/** unit_id → true for every unit with an open let. */
export function occupiedUnitIds(lets: OpenLetLite[]): Set<string> {
  return new Set(lets.filter(letIsOpen).map((l) => l.unit_id));
}

export interface SiteOccupancy {
  total: number;
  occupied: number;
  available: number;
}

/** Occupancy summary for one site's ACTIVE units (archived units don't count). */
export function siteOccupancy(
  units: { id: string; site_id: string; is_active: boolean }[],
  lets: OpenLetLite[],
  siteId: string,
): SiteOccupancy {
  const occupied = occupiedUnitIds(lets);
  const active = units.filter((u) => u.site_id === siteId && u.is_active);
  const occ = active.filter((u) => occupied.has(u.id)).length;
  return { total: active.length, occupied: occ, available: active.length - occ };
}
