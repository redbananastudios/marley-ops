/**
 * Cubic survey engine — totals + van recommendation (the loop iMVE never
 * closes: their sheet stores a number and nothing else happens). Pure and
 * tested; the builder, lead card, quote wizard and job sheet all call these so
 * the maths can never drift between surfaces.
 *
 * Planning happens at a FILL FACTOR (default 90%): a Luton is ~550 usable ft³
 * but a real crew packs to ~90% of that before the load gets slow and risky.
 * Capacities + fill live in business_settings (migration 0029).
 */

import type { VehicleKey } from "@/lib/quote/constants";

export interface CubicLineFlags {
  dismantle?: boolean;
  fragile?: boolean;
  /** Recorded but excluded from the volume total (customer keeps/skips it). */
  notMoving?: boolean;
}

export interface CubicLine {
  /** Immutable UI/persistence identity. Catalogue key is not line identity. */
  id: string;
  /** Catalogue key ("bedrooms:wardrobe-double") or "custom:<uuid>". */
  key: string;
  title: string;
  /** Category key; custom lines carry the category they were added under. */
  category: string;
  qty: number;
  /** Per-unit cubic feet — starts at the catalogue value, editable per line. */
  unitFt3: number;
  flags?: CubicLineFlags;
  note?: string;
  /** Display-only room grouping; canonical inventory deliberately has no room FK. */
  room?: string;
  /** Absent means legacy/manual. Only service-side AI merge may introduce `ai`. */
  source?: "ai" | "manual";
  /** Trusted merge provenance; client saves cannot introduce or replace these. */
  aiDetectionIds?: string[];
}

export const MAX_LINES = 300;
export const MAX_QTY = 999;
export const MAX_UNIT_FT3 = 2000;
export const MAX_AI_DETECTION_IDS = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createCubicLineId = (): string => globalThis.crypto.randomUUID();

export interface CubicTotals {
  /** Volume that moves (notMoving lines excluded). */
  totalFt3: number;
  totalM3: number;
  itemCount: number;
  lineCount: number;
  byCategory: { category: string; ft3: number; items: number }[];
  dismantleCount: number;
  fragileCount: number;
  notMovingCount: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 1 ft³ = 0.0283168 m³ */
export const ft3ToM3 = (ft3: number): number => Math.round(ft3 * 0.0283168 * 10) / 10;

export function computeCubicTotals(lines: CubicLine[]): CubicTotals {
  const byCat = new Map<string, { ft3: number; items: number }>();
  let totalFt3 = 0;
  let itemCount = 0;
  let dismantleCount = 0;
  let fragileCount = 0;
  let notMovingCount = 0;

  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    const unit = Number(l.unitFt3) || 0;
    if (qty <= 0) continue;
    if (l.flags?.notMoving) {
      notMovingCount += qty;
      continue; // recorded, never counted — and its other flags create no crew work
    }
    if (l.flags?.dismantle) dismantleCount += qty;
    if (l.flags?.fragile) fragileCount += qty;
    const ft3 = qty * unit;
    totalFt3 += ft3;
    itemCount += qty;
    const cur = byCat.get(l.category) ?? { ft3: 0, items: 0 };
    cur.ft3 += ft3;
    cur.items += qty;
    byCat.set(l.category, cur);
  }

  return {
    totalFt3: round1(totalFt3),
    totalM3: ft3ToM3(totalFt3),
    itemCount,
    lineCount: lines.length,
    byCategory: [...byCat.entries()]
      .map(([category, v]) => ({ category, ft3: round1(v.ft3), items: v.items }))
      .sort((a, b) => b.ft3 - a.ft3),
    dismantleCount,
    fragileCount,
    notMovingCount,
  };
}

/* ------------------------------------------------- crew survey inventory */

export interface SurveyInventoryItem {
  title: string;
  qty: number;
  /** Line total ft³ (qty × unit), rounded — display only, never a price. */
  ft3: number;
  flags: { dismantle: boolean; fragile: boolean; notMoving: boolean };
  note?: string;
}

export interface SurveyInventoryRoom {
  /** Real room name, or "General" for lines with no room. */
  room: string;
  items: SurveyInventoryItem[];
}

export const GENERAL_ROOM = "General";

/**
 * Room-group the canonical cubic lines for a crew's eyes — the FULL item list
 * the survey collected, price-free. notMoving lines are INCLUDED (a crew needs
 * to know what to leave) and flagged; the work-tally counts (computeCubicTotals)
 * still exclude them. Sorted by room, the "General" bucket last.
 */
export function groupCubicLinesByRoom(lines: CubicLine[]): SurveyInventoryRoom[] {
  const byRoom = new Map<string, SurveyInventoryItem[]>();
  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    if (qty <= 0) continue;
    const unit = Number(l.unitFt3) || 0;
    const room = (typeof l.room === "string" && l.room.trim()) || GENERAL_ROOM;
    const item: SurveyInventoryItem = {
      title: l.title,
      qty,
      ft3: Math.round(qty * unit * 10) / 10,
      flags: {
        dismantle: l.flags?.dismantle === true,
        fragile: l.flags?.fragile === true,
        notMoving: l.flags?.notMoving === true,
      },
      // Line notes reach CREW surfaces (job page + printed sheet). Today they
      // only originate from the AI pipeline / customer self-fill (price-free by
      // nature). If a per-line OFFICE note input is ever added, split it
      // internal-vs-crew-safe first, like cubic_surveys.notes/customer_notes.
      note: typeof l.note === "string" && l.note.trim() ? l.note.trim() : undefined,
    };
    const arr = byRoom.get(room) ?? [];
    arr.push(item);
    byRoom.set(room, arr);
  }
  return [...byRoom.entries()]
    .map(([room, items]) => ({ room, items }))
    .sort((a, b) => {
      if (a.room === GENERAL_ROOM) return 1;
      if (b.room === GENERAL_ROOM) return -1;
      return a.room.localeCompare(b.room, "en-GB");
    });
}

export interface VanCapacities {
  fillPct: number; // e.g. 90
  transitFt3: number;
  lutonFt3: number;
  sevenFiveTFt3: number;
}

export const DEFAULT_CAPACITIES: VanCapacities = {
  fillPct: 90,
  transitFt3: 280,
  lutonFt3: 550,
  sevenFiveTFt3: 1400,
};

export interface VanRecommendation {
  /** Maps straight onto the quote wizard's vehicle select. */
  vehicleKey: VehicleKey;
  lutonCount: number; // 0 when transit
  /** Fractional Luton loads at the planned fill (e.g. 1.5). */
  lutonLoads: number;
  /** "812 ft³ ≈ 1.7 Luton loads" style summary. */
  label: string;
  /** Fleet-reality hint once the move needs 3+ Lutons. */
  consider75t: boolean;
  /** How many 7.5t loads the volume represents at the planned fill. */
  sevenFiveTLoads: number;
  /** 0–100 fill of the recommended combination. */
  fillOfRecommendationPct: number;
}

export function recommendVans(totalFt3: number, caps: VanCapacities = DEFAULT_CAPACITIES): VanRecommendation | null {
  const total = Number(totalFt3) || 0;
  if (total <= 0) return null;
  const fill = Math.min(Math.max(caps.fillPct, 50), 100) / 100;
  const usableTransit = caps.transitFt3 * fill;
  const usableLuton = caps.lutonFt3 * fill;
  const usable75 = caps.sevenFiveTFt3 * fill;

  const lutonLoads = Math.round((total / usableLuton) * 10) / 10;
  const sevenFiveTLoads = usable75 > 0 ? Math.max(1, Math.ceil(total / usable75)) : 0;

  if (total <= usableTransit) {
    return {
      vehicleKey: "transit",
      lutonCount: 0,
      lutonLoads,
      label: `${total.toFixed(0)} ft³ fits a Transit at ${caps.fillPct}% fill`,
      consider75t: false,
      sevenFiveTLoads,
      fillOfRecommendationPct: Math.round((total / usableTransit) * 100),
    };
  }

  const n = Math.min(5, Math.max(1, Math.ceil(total / usableLuton)));
  const capped = total > usableLuton * 5;
  const consider75t = n >= 3;
  return {
    vehicleKey: `${n}luton` as VehicleKey,
    lutonCount: n,
    lutonLoads,
    label:
      `${total.toFixed(0)} ft³ ≈ ${lutonLoads} Luton load${lutonLoads === 1 ? "" : "s"} at ${caps.fillPct}% fill` +
      (consider75t ? ` · fits ${sevenFiveTLoads} × 7.5t` : "") +
      (capped ? " — exceeds 5 Lutons" : ""),
    consider75t,
    sevenFiveTLoads,
    fillOfRecommendationPct: Math.min(999, Math.round((total / (usableLuton * n)) * 100)),
  };
}

/** Human line for chips/PDF: "2 Lutons" / "Transit van". */
export function vehicleShortLabel(rec: VanRecommendation): string {
  return rec.vehicleKey === "transit" ? "Transit van" : `${rec.lutonCount} Luton${rec.lutonCount === 1 ? "" : "s"}`;
}

/* ------------------------------------------------- validation (server) */

export function sanitizeCubicLines(raw: unknown): CubicLine[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LINES) return null;
  const out: CubicLine[] = [];
  const seenIds = new Set<string>();
  for (const l of raw) {
    if (typeof l !== "object" || l === null) return null;
    const o = l as Record<string, unknown>;
    const key = String(o.key ?? "").slice(0, 120);
    const title = String(o.title ?? "").trim().slice(0, 120);
    const category = String(o.category ?? "").slice(0, 60);
    const qty = Math.floor(Number(o.qty));
    const unitFt3 = Number(o.unitFt3);
    const suppliedId = o.id;
    if (suppliedId !== undefined && (typeof suppliedId !== "string" || !UUID_RE.test(suppliedId))) return null;
    const id = typeof suppliedId === "string" ? suppliedId : createCubicLineId();
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    if (!key || !title || !category) return null;
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) return null;
    if (!Number.isFinite(unitFt3) || unitFt3 < 0 || unitFt3 > MAX_UNIT_FT3) return null;
    const f = (o.flags ?? {}) as Record<string, unknown>;
    const line: CubicLine = {
      id,
      key,
      title,
      category,
      qty,
      unitFt3: Math.round(unitFt3 * 10) / 10,
      flags: {
        dismantle: f.dismantle === true,
        fragile: f.fragile === true,
        notMoving: f.notMoving === true,
      },
      note: typeof o.note === "string" ? o.note.trim().slice(0, 300) : undefined,
    };
    if (typeof o.room === "string") {
      const room = o.room.trim();
      if (room.length > 0 && room.length <= 60) line.room = room;
    }
    if (o.source === "ai" || o.source === "manual") line.source = o.source;
    if (
      Array.isArray(o.aiDetectionIds) &&
      o.aiDetectionIds.length > 0 &&
      o.aiDetectionIds.length <= MAX_AI_DETECTION_IDS &&
      o.aiDetectionIds.every((value) => typeof value === "string" && UUID_RE.test(value)) &&
      new Set(o.aiDetectionIds).size === o.aiDetectionIds.length
    ) {
      line.aiDetectionIds = [...o.aiDetectionIds] as string[];
    }
    out.push(line);
  }
  return out;
}

/**
 * Client payloads may edit ordinary inventory fields, but only the service-side
 * AI confirm transaction may create/change room and detection provenance.
 */
export function reconcileCubicLineProvenance(incoming: CubicLine[], trustedExisting: CubicLine[]): CubicLine[] {
  const trustedById = new Map(trustedExisting.map((line) => [line.id, line]));
  return incoming.map((line) => {
    const trusted = trustedById.get(line.id);
    const ordinary = { ...line };
    delete ordinary.room;
    delete ordinary.source;
    delete ordinary.aiDetectionIds;
    if (!trusted) return ordinary;

    if (trusted.source === "ai") {
      return {
        ...ordinary,
        ...(trusted.room ? { room: trusted.room } : {}),
        source: "ai" as const,
        ...(trusted.aiDetectionIds ? { aiDetectionIds: [...trusted.aiDetectionIds] } : {}),
      };
    }

    return {
      ...ordinary,
      ...(trusted.room ? { room: trusted.room } : {}),
      ...(trusted.source === "manual" ? { source: "manual" as const } : {}),
    };
  });
}
