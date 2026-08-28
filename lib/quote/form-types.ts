import type { QuoteInputs } from "./pricing";
import type { FloorKey, PackingKey, PropertyType, VehicleKey } from "./constants";
import { addressFromString } from "@/lib/places/parse";

/** Structured address (matches the shared AddressFields shape, kept in a server-safe
 *  lib so form-types stays importable from server actions). */
export interface QuoteAddress {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
}

export const BLANK_QUOTE_ADDRESS: QuoteAddress = {
  line1: "",
  town: "",
  county: "",
  postcode: "",
  country: "United Kingdom",
};

/** One-line string (line1, town, postcode) for mileage + the PDF + the quote columns. */
export function composeAddr(a: QuoteAddress): string {
  return [a.line1, a.town, a.postcode].filter((s) => s && s.trim()).join(", ").trim();
}

/** Full wizard state. The pricing-relevant subset is derived via deriveInputs(). */
export interface QuoteFormValues {
  customer: { name: string; phone: string; email: string };
  job: {
    /** Structured collection/destination addresses (with postcode). */
    collectAddress: QuoteAddress;
    destAddress: QuoteAddress;
    /** Derived one-line strings for mileage + PDF + columns (kept in sync with the above). */
    collectAddr: string;
    destAddr: string;
    moveDate: string;
    moveDateEstimated: boolean;
    /** Days on the job — feeds costing AND the quote (each extra day charges extraDayRate). */
    days: number;
    scope: "rented" | "owned";
    bedsOvernight: "no" | "yes";
  };
  route: { deadMiles: number | null; jobMiles: number | null; routeLegs: RouteLeg[] };
  vehicle: VehicleKey;
  /** Number of 7.5t lorries (0..MAX_75T). */
  sevenFiveT: number;
  /** Number of add-on Transit vans (0..MAX_TRANSIT). */
  transitVans: number;
  packing: PackingKey;
  collect: { type: PropertyType; lift: "no" | "yes"; floor: FloorKey; accessM: number };
  dest: { type: PropertyType; lift: "no" | "yes"; floor: FloorKey; accessM: number };
  extras: { congestion: boolean; tolls: number; parking: number };
  items: QuoteItems;
  /** In-person survey capture — notes from the visit. Not priced (informational,
   *  stored with the quote). Photos live in survey_photos, keyed by the lead. */
  survey: { accessNotes: string; largeItemsNotes: string };
  review: {
    discount: number;
    /** Internal uplift (PRD §3.9) — priced into the subtotal by computeQuote(),
     *  folded inside the customer's "Your Removal" line. Never itemised to the customer. */
    additionalCharges: number;
    /** Short internal reason for the uplift (commercial access, stairs, …). Internal view only. */
    additionalChargesReason: string;
    /**
     * The COMMERCIAL client's own purchase-order reference (PRD §3.10), printed
     * on the completion invoice when present. Optional by design and never
     * blocking: refusing to confirm a booking because a PO has not been issued
     * yet would hold a real job for paperwork.
     *
     * Capped at 64 to match the `quotes_po_number_len` constraint from
     * migration 0113 — a longer value is rejected by the database, which would
     * surface to the office as a failed save with no explanation.
     */
    poNumber: string;
    quoteNotes: string;
  };
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
  babyGrandPianoCover: number;
  babyGrandPianoShoe: number;
  pianoDolly: number;
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
  babyGrandPianoCover: 0,
  babyGrandPianoShoe: 0,
  pianoDolly: 0,
};

export function defaultQuoteValues(): QuoteFormValues {
  return {
    customer: { name: "", phone: "", email: "" },
    job: {
      collectAddress: { ...BLANK_QUOTE_ADDRESS },
      destAddress: { ...BLANK_QUOTE_ADDRESS },
      collectAddr: "",
      destAddr: "",
      moveDate: "",
      moveDateEstimated: false,
      days: 1,
      scope: "rented",
      bedsOvernight: "no",
    },
    route: { deadMiles: null, jobMiles: null, routeLegs: [] },
    vehicle: "1luton",
    sevenFiveT: 0,
    transitVans: 0,
    packing: "owner",
    collect: { type: "house", lift: "no", floor: "ground", accessM: 5 },
    dest: { type: "house", lift: "no", floor: "ground", accessM: 5 },
    extras: { congestion: false, tolls: 0, parking: 0 },
    items: { ...ZERO_ITEMS },
    survey: { accessNotes: "", largeItemsNotes: "" },
    review: {
      discount: 0,
      additionalCharges: 0,
      additionalChargesReason: "",
      poNumber: "",
      quoteNotes: "",
    },
    vatEnabled: false,
  };
}

/**
 * Normalise a loaded state_blob into a clean QuoteFormValues. Handles quotes saved
 * before this change: the legacy single 7.5t boolean (has75T) → count, and the old
 * single address string → structured address. Deep-merges each slice over the defaults
 * so a partial/old blob never yields undefined nested objects.
 */
export function normalizeQuoteValues(raw: unknown): QuoteFormValues {
  const d = defaultQuoteValues();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<QuoteFormValues> & {
    has75T?: boolean;
    job?: Partial<QuoteFormValues["job"]>;
  };
  const job = { ...d.job, ...(r.job ?? {}) };
  // Structured addresses: parse the old single string when absent, so the street /
  // town / postcode land in their own fields instead of everything in line1.
  if (!r.job?.collectAddress) job.collectAddress = addressFromString(job.collectAddr);
  if (!r.job?.destAddress) job.destAddress = addressFromString(job.destAddr);

  return {
    ...d,
    ...r,
    customer: { ...d.customer, ...(r.customer ?? {}) },
    job,
    route: { ...d.route, ...(r.route ?? {}) },
    collect: { ...d.collect, ...(r.collect ?? {}) },
    dest: { ...d.dest, ...(r.dest ?? {}) },
    extras: { ...d.extras, ...(r.extras ?? {}) },
    items: { ...d.items, ...(r.items ?? {}) },
    survey: { ...d.survey, ...(r.survey ?? {}) },
    review: { ...d.review, ...(r.review ?? {}) },
    // Legacy 7.5t boolean → count (only when the count wasn't stored).
    sevenFiveT: r.sevenFiveT ?? (r.has75T ? 1 : 0),
    transitVans: r.transitVans ?? 0,
  };
}

/** Map wizard state → the pure pricing inputs computeQuote() expects. */
export function deriveInputs(v: QuoteFormValues): QuoteInputs {
  return {
    vehicle: v.vehicle,
    packing: v.packing,
    sevenFiveT: v.sevenFiveT ?? 0,
    transitVans: v.transitVans ?? 0,
    days: Number(v.job.days) || 1,
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
    additionalCharges: Number(v.review.additionalCharges) || 0,
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
    ["Baby Grand Piano Cover", items.babyGrandPianoCover],
    ["Baby Grand Piano Shoe", items.babyGrandPianoShoe],
    ["Piano Dolly", items.pianoDolly],
  ];
  return src.map(([label, qty]) => ({ label, qty: Number(qty) || 0 })).filter((i) => i.qty > 0);
}

export type ItemGroup = "Boxes" | "Covers" | "Piano";

/** Wizard field metadata. `step` = stepper increment (defaults to 1 when absent). */
export const ITEM_FIELDS: { key: keyof QuoteItems; label: string; group: ItemGroup; step?: number }[] = [
  { key: "wardrobeBoxes", label: "Wardrobe Boxes", group: "Boxes" },
  { key: "boxesBefore", label: "Boxes Before Move", group: "Boxes", step: 5 },
  { key: "boxesOnCollection", label: "Boxes On Collection", group: "Boxes", step: 5 },
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
  { key: "babyGrandPianoCover", label: "Baby Grand Piano Cover", group: "Piano" },
  { key: "babyGrandPianoShoe", label: "Baby Grand Piano Shoe", group: "Piano" },
  { key: "pianoDolly", label: "Piano Dolly", group: "Piano" },
];
