/**
 * Is the card channel live? — SERVER ONLY.
 * PRD: docs/takepayments-card-payments-prd.md §11.10.
 *
 * Split out of `card-payments.ts` so the answer can be asked from the COMMS
 * layer without dragging the whole payment lifecycle (and its imports of the
 * accept flow, the ledger and the dispatcher) along with it. That module
 * imports the accept flow, and the accept flow is exactly what needs to ask
 * this question before it words an invoice note — so asking it there directly
 * would close an import cycle. This file imports only leaves.
 *
 * `card-payments.ts` re-exports both functions, so every existing importer is
 * unaffected and there is still ONE implementation of the AND rule.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BRAND, getBrand } from "@/lib/brand";
import { getTakepaymentsConfig } from "@/lib/payments/takepayments";

type Sb = SupabaseClient<Database>;

/**
 * Whether the card channel is live for a given brand's quote.
 *
 * THREE things must hold, and they are deliberately ANDed (PRD §11.10): the
 * takepayments env credentials exist, the global kill switch is on, and the
 * BRAND's own switch is on.
 *
 * The brand clause was missing until 2026-08-27 (QA-20260826-07), which made
 * `brands.card_payments_enabled` a dead control: `/q` rendered the card button
 * off the global switch alone, so a brand with card deliberately OFF still got
 * the button while every one of its emails said bank transfer was the only
 * route. That is the exact combination the second brand launches in.
 *
 * `brandSlug` omitted means the default brand — the single-brand path, where
 * this is byte-for-byte the old behaviour.
 */
export async function cardPaymentsAvailable(sb: Sb, brandSlug?: string | null): Promise<boolean> {
  if (!getTakepaymentsConfig()) return false;
  const { data } = await sb
    .from("business_settings")
    .select("card_payments_enabled")
    .eq("id", true)
    .maybeSingle();
  if (data?.card_payments_enabled !== true) return false;

  const slug = (brandSlug ?? "").trim();
  if (!slug || slug === DEFAULT_BRAND) return true;
  // A brand row that cannot be read is not a brand with card ON. Failing open
  // here would put a card button on a surface whose copy says bank-only.
  const brand = await getBrand(sb, slug).catch(() => null);
  return brand?.cardPaymentsEnabled === true;
}

/**
 * Which brand slugs currently have a LIVE card channel — the same three
 * conditions as `cardPaymentsAvailable`, resolved once for a whole page.
 *
 * A list surface spans brands, so asking per row would be one round trip per
 * booking; asking once and testing membership keeps the precedence rule in one
 * place while staying a single read. An empty set is the correct answer for
 * every failure mode here (no credentials, kill switch off, unreadable table):
 * failing open would put a card affordance on a surface whose copy says bank
 * transfer is the only route.
 */
export async function cardEnabledBrands(sb: Sb): Promise<Set<string>> {
  if (!getTakepaymentsConfig()) return new Set();
  const { data: settings } = await sb
    .from("business_settings")
    .select("card_payments_enabled")
    .eq("id", true)
    .maybeSingle();
  if (settings?.card_payments_enabled !== true) return new Set();

  // The default brand is live on the global switch alone — it has no row-level
  // opt-in to satisfy, exactly as cardPaymentsAvailable treats it.
  const live = new Set<string>([DEFAULT_BRAND]);
  const { data, error } = await sb
    .from("brands")
    .select("slug, card_payments_enabled")
    .eq("card_payments_enabled", true);
  if (error) return live;
  for (const row of (data ?? []) as { slug: string }[]) live.add(row.slug);
  return live;
}
