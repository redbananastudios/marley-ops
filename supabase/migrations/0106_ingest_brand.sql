-- 0106: website submission ids become unique PER BRAND, not globally
-- (docs/multi-brand-prd.md §3.8, gate 19 — successor to 0102, which created
-- the single-column index this file replaces).
--
-- The bug this fixes is silent cross-brand data loss. Each brand's website
-- mints its own submission ids independently, so two sites WILL both mint id
-- "1234" eventually. Under 0102's index on external_lead_id alone, whichever
-- brand submits second reads as a duplicate of the first: the dedupe check
-- (and the unique index backing it against races) answer "already handled",
-- the route returns 200, and the second brand's customer never appears in the
-- panel — a false "already handled", with the caller's own fallback (email
-- the office, text Peter) switched off by our success response. Keying the
-- index — and the adoption reads in lib/leads/website-lead.ts — on
-- (brand, external_lead_id) keeps the id spaces apart: same id under two
-- brands is two leads; same id under one brand is still one.
--
-- Create-then-drop, in that order, so there is no moment without a uniqueness
-- guarantee even if this file is ever applied statement by statement outside
-- a transaction. The two indexes coexist harmlessly for the instant between:
-- the new one is strictly weaker than the old, so existing rows (all
-- brand = 'marley' via 0104's backfill) cannot violate it.
--
-- Partial, like 0102: NULLs never collide, so every lead that did not come
-- from a website (phone, walk-in, referral, the iMVE and Pitmans imports) is
-- unaffected. leads_sanity_uq stays single-column on purpose — Sanity mints
-- globally-unique document ids and only Marley's pull rail carries one.

create unique index if not exists leads_external_lead_brand_uq
  on leads(brand, external_lead_id)
  where external_lead_id is not null;

drop index if exists leads_external_lead_uq;
