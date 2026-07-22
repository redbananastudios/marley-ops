import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supplier (Sandys) cost card — SERVER-SIDE ONLY. Never import VALUES from
 * this module in a "use client" file: the defaults below are the real current
 * Sandys figures, and supplier costs/margin are admin-only (the whole reason
 * they live in the RLS-gated storage_supplier_rates singleton rather than
 * business_settings). Client components may `import type` the interface.
 *
 * Figures are GROSS (FRS: no input VAT recovery — the gross column is the
 * real cost). Customer-facing rates live in lib/storage-rates.ts.
 */

export interface StorageSupplierCosts {
  /** Gross monthly cost per container held (accrues regardless of occupancy). */
  containerMonthCost: number;
  /** How many containers Marley pays for each month. */
  containersCount: number;
  /** Gross cost per crate per day at Sandys. */
  crateDayCost: number;
  /** Gross cost per handling event (crate in/out/access) charged by Sandys. */
  handlingEventCost: number;
}

export const DEFAULT_SUPPLIER_COSTS: StorageSupplierCosts = {
  containerMonthCost: 174,
  containersCount: 2,
  crateDayCost: 1.7143,
  handlingEventCost: 60,
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function mapSupplierCosts(raw: unknown): StorageSupplierCosts {
  const d = DEFAULT_SUPPLIER_COSTS;
  if (!raw || typeof raw !== "object") return { ...d };
  const s = raw as Record<string, unknown>;
  return {
    containerMonthCost: num(s.container_month_cost, d.containerMonthCost),
    containersCount: Math.max(0, Math.trunc(num(s.containers_count, d.containersCount))),
    crateDayCost: num(s.crate_day_cost, d.crateDayCost),
    handlingEventCost: num(s.handling_event_cost, d.handlingEventCost),
  };
}

/** DB (snake_case jsonb) shape for storage_supplier_rates.data — the write half. */
export function supplierCostsToDb(s: StorageSupplierCosts): Record<string, unknown> {
  return {
    container_month_cost: s.containerMonthCost,
    containers_count: s.containersCount,
    crate_day_cost: s.crateDayCost,
    handling_event_cost: s.handlingEventCost,
  };
}

/**
 * Read the admin-only singleton with the CALLER's client. RLS returns no row
 * to a non-admin → null (callers hide the cost surface). A read ERROR throws —
 * it must never be mistaken for the no-row case, or an admin gets treated like
 * an estimator and a subsequent Settings save would overwrite the real
 * supplier figures with defaults.
 */
export async function getSupplierRates(sb: SupabaseClient): Promise<StorageSupplierCosts | null> {
  const { data, error } = await sb.from("storage_supplier_rates").select("data").eq("id", true).maybeSingle();
  if (error) throw new Error(`storage_supplier_rates read failed: ${error.message}`);
  if (!data) return null;
  return mapSupplierCosts((data as { data?: unknown }).data);
}
