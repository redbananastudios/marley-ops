import type { QuoteInputs } from "./pricing";
import type { FloorKey, PackingKey, PropertyType, VehicleKey } from "./constants";

/** Full wizard state. The pricing-relevant subset is derived via deriveInputs(). */
export interface QuoteFormValues {
  customer: { name: string; phone: string; email: string };
  job: {
    collectAddr: string;
    destAddr: string;
    moveDate: string;
    moveDateEstimated: boolean;
    /** Estimated days on the job — internal costing only (labour/van), not charged. */
    days: number;
    scope: "rented" | "owned";
    bedsOvernight: "no" | "yes";
  };
  route: { deadMiles: number | null; jobMiles: number | null; routeLegs: RouteLeg[] };
  vehicle: VehicleKey;
  has75T: boolean;
  packing: PackingKey;
  collect: { type: PropertyType; lift: "no" | "yes"; floor: FloorKey; accessM: number };
  dest: { type: PropertyType; lift: "no" | "yes"; floor: FloorKey; accessM: number };
  extras: { congestion: boolean; tolls: number; parking: number };
  items: QuoteItems;
  /** In-person survey capture — notes from the visit. Not priced (informational,
   *  stored with the quote). Photos live in survey_photos, keyed by the lead. */
  survey: { accessNotes: string; largeItemsNotes: string };
  review: { discount: number; quoteNotes: string };
  vatEnabled: boolean;
}

export interface RouteLeg {
  label: string;
  dist: string;
  time: string;
}

/** Informational packing inventory (NOT priced). New v1 items: mattress single/double + dining chair covers. */
export interface QuoteItems {
  wardrobeBoxes: number;
  boxesBefore: number;
  boxesOnCollection: number;
  mirrorsQty: number;
  mattressSingle: number;
  mattressDouble: number;
  diningChairCovers: number;
  cov2Seater: number;
  cov3Seater: number;
  covArmchair: number;
  covWhiteGoods: number;
  covFridge: number;
  covTV: number;
  covDiningTable: number;
}

export const ZERO_ITEMS: QuoteItems = {
  wardrobeBoxes: 0,
  boxesBefore: 0,
  boxesOnCollection: 0,
  mirrorsQty: 0,
  mattressSingle: 0,
  mattressDouble: 0,
  diningChairCovers: 0,
  cov2Seater: 0,
  cov3Seater: 0,
  covArmchair: 0,
  covWhiteGoods: 0,
  covFridge: 0,
  covTV: 0,
  covDiningTable: 0,
};

export function defaultQuoteValues(): QuoteFormValues {
  return {
    customer: { name: "", phone: "", email: "" },
    job: { collectAddr: "", destAddr: "", moveDate: "", moveDateEstimated: false, days: 1, scope: "rented", bedsOvernight: "no" },
    route: { deadMiles: null, jobMiles: null, routeLegs: [] },
    vehicle: "1luton",
    has75T: false,
    packing: "owner",
    collect: { type: "house", lift: "no", floor: "ground", accessM: 0 },
    dest: { type: "house", lift: "no", floor: "ground", accessM: 0 },
    extras: { congestion: false, tolls: 0, parking: 0 },
    items: { ...ZERO_ITEMS },
    survey: { accessNotes: "", largeItemsNotes: "" },
    review: { discount: 0, quoteNotes: "" },
    vatEnabled: false,
  };
}

/** Map wizard state → the pure pricing inputs computeQuote() expects. */
export function deriveInputs(v: QuoteFormValues): QuoteInputs {
  return {
    vehicle: v.vehicle,
    packing: v.packing,
    has75T: v.has75T,
    deadMiles: v.route.deadMiles,
    jobMiles: v.route.jobMiles,
    collectAccessM: Number(v.collect.accessM) || 0,
    destAccessM: Number(v.dest.accessM) || 0,
    collectType: v.collect.type,
    collectFloor: v.collect.floor,
    destType: v.dest.type,
    destFloor: v.dest.floor,
    congestion: v.extras.congestion,
    tolls: Number(v.extras.tolls) || 0,
    parking: Number(v.extras.parking) || 0,
    discount: Number(v.review.discount) || 0,
    vatEnabled: v.vatEnabled,
  };
}

/** Operational requirements list for the PDF (label + qty), filtered to qty > 0. */
export function buildOpItems(items: QuoteItems): { label: string; qty: number }[] {
  const src: [string, number][] = [
    ["Wardrobe Boxes", items.wardrobeBoxes],
    ["Boxes Before Move", items.boxesBefore],
    ["Boxes On Collection", items.boxesOnCollection],
    ["Mirrors & Pictures", items.mirrorsQty],
    ["Mattress Covers (Single)", items.mattressSingle],
    ["Mattress Covers (Double)", items.mattressDouble],
    ["Dining Chair Covers", items.diningChairCovers],
    ["2 Seater Sofa Covers", items.cov2Seater],
    ["3 Seater Sofa Covers", items.cov3Seater],
    ["Armchair Covers", items.covArmchair],
    ["White Goods Covers", items.covWhiteGoods],
    ["Fridge Freezer Covers", items.covFridge],
    ["TV Boxes", items.covTV],
    ["Dining Table Covers", items.covDiningTable],
  ];
  return src.map(([label, qty]) => ({ label, qty: Number(qty) || 0 })).filter((i) => i.qty > 0);
}

export const ITEM_FIELDS: { key: keyof QuoteItems; label: string; group: "Boxes" | "Covers" }[] = [
  { key: "wardrobeBoxes", label: "Wardrobe Boxes", group: "Boxes" },
  { key: "boxesBefore", label: "Boxes Before Move", group: "Boxes" },
  { key: "boxesOnCollection", label: "Boxes On Collection", group: "Boxes" },
  { key: "mirrorsQty", label: "Mirrors & Pictures", group: "Boxes" },
  { key: "mattressSingle", label: "Mattress Covers (Single)", group: "Covers" },
  { key: "mattressDouble", label: "Mattress Covers (Double)", group: "Covers" },
  { key: "diningChairCovers", label: "Dining Chair Covers", group: "Covers" },
  { key: "cov2Seater", label: "2 Seater Sofa Covers", group: "Covers" },
  { key: "cov3Seater", label: "3 Seater Sofa Covers", group: "Covers" },
  { key: "covArmchair", label: "Armchair Covers", group: "Covers" },
  { key: "covWhiteGoods", label: "White Goods Covers", group: "Covers" },
  { key: "covFridge", label: "Fridge Freezer Covers", group: "Covers" },
  { key: "covTV", label: "TV Boxes", group: "Covers" },
  { key: "covDiningTable", label: "Dining Table Covers", group: "Covers" },
];
