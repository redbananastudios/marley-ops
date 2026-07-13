/**
 * PostgREST caps every response at PGRST_DB_MAX_ROWS (1000 on our self-hosted
 * Supabase). A plain fetch-all select therefore SILENTLY truncates once a table
 * grows past 1000 rows — leads/quotes/clients pages would quietly drop data.
 * This helper pages through .range() windows and stitches the full set back
 * together. Use it for any unbounded list select on a growing table.
 */

import { log } from "@/lib/log";

const BATCH = 1000;

export async function fetchAllRows<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await query(from, from + BATCH - 1);
    if (error) {
      // Fail-soft with what we have — the page renders rather than 500s, and the
      // first window (newest rows) is always present.
      log.error("fetch-all.window_failed", { from, gotSoFar: out.length, error: error.message });
      break;
    }
    out.push(...(data ?? []));
    if (!data || data.length < BATCH) break;
  }
  return out;
}
