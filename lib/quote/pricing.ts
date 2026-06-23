/**
 * Quote pricing engine — pure, framework-free transcription of the live MM Quotes
 * `gatherQuoteData()` (quotes-app/public/index.html L2301-2342) + its two helpers
 * (`getAccessCharge` / `getFloorCharge`, L2288-2296).
 *
 * This is the ONLY place money is computed in Marley Ops. The wizard, the PDF, the
 * panel-edit screen and the tests all call computeQuote() so totals can never drift.
 *
 * Transcribed character-for-character: same operators, same order, same Math.max(0,…),
 * same `* 0.20`. Do NOT refactor the arithmetic — float reordering can shift a penny.
 * VAT is a single line at the very end: (subtotal incl. £150 admin fee − discount) × 20%.
 */

import {
  ADDON_75T_BASE,
  ADDON_75T_PACK,
  ADMIN_FEE,
  BASE_PRICES,
  CONGESTION_PER_VAN,
  FLOOR_PRICES,
  MILEAGE_RATE,
  PACK_PRICES,
  VAN_COUNT,
  type FloorKey,
  type PackingKey,
  type PropertyType,
  type VehicleKey,
} from './constants';

/**
 * Editable price levers. computeQuote defaults to DEFAULT_PRICING (the locked
 * constants) so the live engine + every test are unchanged; the margin calculator
 * passes an overridden config to model "what if I charged X". Access tiers (£100/£300)
 * and the 20% VAT rate stay fixed for now.
 */
export interface PricingConfig {
  base: Record<VehicleKey, number>;
  pack: Record<VehicleKey, Record<PackingKey, number>>;
  addon75Base: number;
  addon75Pack: Record<PackingKey, number>;
  floor: Record<FloorKey, number>;
  adminFee: number;
  mileageRate: number;
  congestionPerVan: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  base: BASE_PRICES,
  pack: PACK_PRICES,
  addon75Base: ADDON_75T_BASE,
  addon75Pack: ADDON_75T_PACK,
  floor: FLOOR_PRICES,
  adminFee: ADMIN_FEE,
  mileageRate: MILEAGE_RATE,
  congestionPerVan: CONGESTION_PER_VAN,
};

export interface QuoteInputs {
  vehicle: VehicleKey;
  packing: PackingKey;
  has75T: boolean;
  /** Dead miles (base→collect + dest→base). null until the 3-leg route is calculated. */
  deadMiles: number | null;
  /** Job miles (collect→dest). null until calculated. */
  jobMiles: number | null;
  collectAccessM: number;
  destAccessM: number;
  collectType: PropertyType;
  collectFloor: FloorKey;
  destType: PropertyType;
  destFloor: FloorKey;
  congestion: boolean;
  tolls: number;
  parking: number;
  discount: number;
  vatEnabled: boolean;
}

export interface QuoteBreakdown {
  vehicle: VehicleKey;
  packing: PackingKey;
  has75T: boolean;
  vanCount: number;
  base: number;
  packCost: number;
  addon75Cost: number;
  addon75PackCost: number;
  mileageCost: number | null;
  totalMiles: number | null;
  collectAccessM: number;
  destAccessM: number;
  collectAccessCost: number;
  destAccessCost: number;
  collectType: PropertyType;
  collectFloor: FloorKey;
  destType: PropertyType;
  destFloor: FloorKey;
  collectFloorCost: number;
  destFloorCost: number;
  congestion: number;
  tolls: number;
  parking: number;
  discount: number;
  subtotal: number;
  total: number;
  vatEnabled: boolean;
  vatAmount: number;
  grandTotal: number;
  adminFee: number;
}

/** L2288-2292 verbatim. `!m` keeps 0/NaN at £0; 10–20m → £100; >20m → £300. */
export function getAccessCharge(m: number): number {
  if (!m || m < 10) return 0;
  if (m <= 20) return 100;
  return 300;
}

/** L2293-2296 verbatim. Floor charge applies per-van AND only when the property is a flat. */
export function getFloorCharge(
  floor: FloorKey,
  isFlat: boolean,
  vanCount: number,
  floorPrices: Record<FloorKey, number> = FLOOR_PRICES,
): number {
  if (!isFlat) return 0;
  return (floorPrices[floor] || 0) * vanCount;
}

/**
 * Transcription of gatherQuoteData() L2301-2342. The DOM reads in the original become
 * the typed QuoteInputs; the arithmetic is identical. Defensive `|| default` fallbacks
 * mirror the live tool's `getRadioValue(...) || 'default'`.
 */
export function computeQuote(i: QuoteInputs, pricing: PricingConfig = DEFAULT_PRICING): QuoteBreakdown {
  const vehicle = i.vehicle || '1luton';
  const packing = i.packing || 'owner';
  const has75T = i.has75T;
  const lutonVanCount = VAN_COUNT[vehicle];
  const vanCount = lutonVanCount + (has75T ? 1 : 0);
  const base = pricing.base[vehicle];
  const packCost = pricing.pack[vehicle][packing];
  const addon75Cost = has75T ? pricing.addon75Base : 0;
  const addon75PackCost = has75T ? pricing.addon75Pack[packing] : 0;

  let mileageCost: number | null = null;
  let totalMiles: number | null = null;
  if (i.deadMiles !== null && i.jobMiles !== null) {
    totalMiles = i.deadMiles + i.jobMiles;
    mileageCost = totalMiles * pricing.mileageRate;
  }

  const collectAccessM = i.collectAccessM || 0;
  const destAccessM = i.destAccessM || 0;
  const collectAccessCost = getAccessCharge(collectAccessM);
  const destAccessCost = getAccessCharge(destAccessM);

  const collectType = i.collectType || 'house';
  const collectFloor = i.collectFloor || 'ground';
  const destType = i.destType || 'house';
  const destFloor = i.destFloor || 'ground';
  const collectFloorCost = getFloorCharge(collectFloor, collectType === 'flat', vanCount, pricing.floor);
  const destFloorCost = getFloorCharge(destFloor, destType === 'flat', vanCount, pricing.floor);

  const congestion = i.congestion ? vanCount * pricing.congestionPerVan : 0;
  const tolls = i.tolls || 0;
  const parking = i.parking || 0;
  const discount = i.discount || 0;

  const subtotal =
    base +
    packCost +
    addon75Cost +
    addon75PackCost +
    (mileageCost || 0) +
    collectAccessCost +
    destAccessCost +
    collectFloorCost +
    destFloorCost +
    congestion +
    tolls +
    parking +
    pricing.adminFee;
  const total = Math.max(0, subtotal - discount);
  const vatEnabled = i.vatEnabled;
  const vatAmount = vatEnabled ? total * 0.2 : 0;
  const grandTotal = total + vatAmount;

  return {
    vehicle,
    packing,
    has75T,
    vanCount,
    base,
    packCost,
    addon75Cost,
    addon75PackCost,
    mileageCost,
    totalMiles,
    collectAccessM,
    destAccessM,
    collectAccessCost,
    destAccessCost,
    collectType,
    collectFloor,
    destType,
    destFloor,
    collectFloorCost,
    destFloorCost,
    congestion,
    tolls,
    parking,
    discount,
    subtotal,
    total,
    vatEnabled,
    vatAmount,
    grandTotal,
    adminFee: pricing.adminFee,
  };
}
