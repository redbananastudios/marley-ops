/**
 * Quote pricing constants — VERBATIM transcription of the live MM Quotes engine.
 * Source: quotes-app/public/index.html  (constants block ~L1973-1984).
 *
 * DO NOT "tidy", round, or reorder. These values + lib/quote/pricing.ts are the
 * single source of truth for money in Marley Ops. Any change here must be matched
 * against the live tool and re-verified by tests/lib/quote/pricing.test.ts.
 */

export type VehicleKey = 'transit' | '1luton' | '2luton' | '3luton' | '4luton' | '5luton';
export type PackingKey = 'full' | 'fragile' | 'owner';
export type FloorKey = 'ground' | '1st' | '2nd' | '3rd';
export type PropertyType = 'house' | 'flat';

/** All base-vehicle tiers in order — used for dropdowns + iterating the price grid.
 *  Transit is the smallest tier (single man-and-van); it can ALSO ride along as an
 *  add-on count (ADDON_TRANSIT_BASE), like the 7.5t. */
export const VEHICLE_KEYS: VehicleKey[] = ['transit', '1luton', '2luton', '3luton', '4luton', '5luton'];

/** Default prices. These are the SEED + fallback for the editable settings prices
 *  (business_settings.pricing) and the baseline the golden tests pin to. */
export const BASE_PRICES: Record<VehicleKey, number> = {
  transit: 350,
  '1luton': 700,
  '2luton': 1200,
  '3luton': 1950,
  '4luton': 2500,
  '5luton': 3000,
};

export const VAN_COUNT: Record<VehicleKey, number> = {
  transit: 1,
  '1luton': 1,
  '2luton': 2,
  '3luton': 3,
  '4luton': 4,
  '5luton': 5,
};

export const PACK_PRICES: Record<VehicleKey, Record<PackingKey, number>> = {
  // Transit packing not priced yet — set real figures in Settings > Quote prices if sold.
  transit: { full: 0, fragile: 0, owner: 0 },
  '1luton': { full: 450, fragile: 225, owner: 0 },
  '2luton': { full: 750, fragile: 350, owner: 0 },
  '3luton': { full: 995, fragile: 450, owner: 0 },
  '4luton': { full: 1100, fragile: 600, owner: 0 },
  '5luton': { full: 1300, fragile: 700, owner: 0 },
};

export const ADDON_75T_BASE = 1600;
export const ADDON_75T_PACK: Record<PackingKey, number> = { full: 750, fragile: 350, owner: 0 };
/** Max 7.5t lorries selectable on one job. */
export const MAX_75T = 2;

/** Transit as an ADD-ON vehicle (on top of the base tier): flat per van, 1 man included. */
export const ADDON_TRANSIT_BASE = 350;
/** Max add-on Transit vans selectable on one job. */
export const MAX_TRANSIT = 2;

export const FLOOR_PRICES: Record<FloorKey, number> = { ground: 0, '1st': 75, '2nd': 150, '3rd': 250 };

export const ADMIN_FEE = 150;
export const MILEAGE_RATE = 2.0;
export const CONGESTION_PER_VAN = 20;
export const VAT_RATE = 0.2;
