/**
 * Quote pricing constants — VERBATIM transcription of the live MM Quotes engine.
 * Source: quotes-app/public/index.html  (constants block ~L1973-1984).
 *
 * DO NOT "tidy", round, or reorder. These values + lib/quote/pricing.ts are the
 * single source of truth for money in Marley Ops. Any change here must be matched
 * against the live tool and re-verified by tests/lib/quote/pricing.test.ts.
 */

export type VehicleKey = '1luton' | '2luton' | '3luton';
export type PackingKey = 'full' | 'fragile' | 'owner';
export type FloorKey = 'ground' | '1st' | '2nd' | '3rd';
export type PropertyType = 'house' | 'flat';

export const BASE_PRICES: Record<VehicleKey, number> = {
  '1luton': 700,
  '2luton': 1350,
  '3luton': 1950,
};

export const VAN_COUNT: Record<VehicleKey, number> = {
  '1luton': 1,
  '2luton': 2,
  '3luton': 3,
};

export const PACK_PRICES: Record<VehicleKey, Record<PackingKey, number>> = {
  '1luton': { full: 450, fragile: 225, owner: 0 },
  '2luton': { full: 750, fragile: 350, owner: 0 },
  '3luton': { full: 995, fragile: 450, owner: 0 },
};

export const ADDON_75T_BASE = 1600;
export const ADDON_75T_PACK: Record<PackingKey, number> = { full: 1550, fragile: 700, owner: 0 };

export const FLOOR_PRICES: Record<FloorKey, number> = { ground: 0, '1st': 75, '2nd': 150, '3rd': 250 };

export const ADMIN_FEE = 150;
export const MILEAGE_RATE = 2.0;
export const CONGESTION_PER_VAN = 20;
export const VAT_RATE = 0.2;
