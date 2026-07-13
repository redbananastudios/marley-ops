/**
 * Group Ops-side leads by their landing variant (utm_content carries the
 * agents' variant_key verbatim). Pure — testable without a DB.
 */

export type VariantLead = { utm_content: string | null; status: string };

export type VariantRow = {
  variant: string;
  total: number;
  won: number;
  winRate: number; // 0-100, rounded
};

/** Statuses that count as a won job, matching the performance page. */
const WON = new Set(["confirmed", "completed"]);

export function groupLeadsByVariant(leads: VariantLead[]): { rows: VariantRow[]; untagged: number } {
  const byVariant = new Map<string, { total: number; won: number }>();
  let untagged = 0;
  for (const l of leads) {
    const v = (l.utm_content ?? "").trim();
    if (!v) {
      untagged += 1;
      continue;
    }
    const cur = byVariant.get(v) ?? { total: 0, won: 0 };
    cur.total += 1;
    if (WON.has(l.status)) cur.won += 1;
    byVariant.set(v, cur);
  }
  const rows = [...byVariant.entries()]
    .map(([variant, c]) => ({
      variant,
      total: c.total,
      won: c.won,
      winRate: c.total === 0 ? 0 : Math.round((c.won / c.total) * 100),
    }))
    .sort((a, b) => b.total - a.total || a.variant.localeCompare(b.variant));
  return { rows, untagged };
}
