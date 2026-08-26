-- 0105: Additional Charges — an internal uplift on the quote (multi-brand PRD §3.9, gate 7).
--
-- An amount plus a short reason ('commercial access', 'stairs', 'specialist
-- handling'), visible ONLY to office and estimator. Needed from day one for the
-- commercial work Pitmans brings, where jobs routinely carry site costs the
-- standard rate card doesn't price.
--
-- The customer never sees it as a line: customerLineItems() absorbs the amount
-- into the collapsed "Your Removal" line (never a separate hidden addend — the
-- PDF's own sum-to-subtotal invariant would break otherwise). The uplift enters
-- computeQuote()'s subtotal, so quotes.grand_total already includes it: it counts
-- as revenue in lib/margin.ts and flows into the 25% commitment maths naturally,
-- because the commitment computes from gross. The amount is also mirrored into
-- the breakdown JSON (breakdown.additionalCharges) so the PDF renders from one
-- payload; the REASON deliberately is not — it lives only here and in state_blob,
-- so no customer-facing renderer can ever reach it.
--
-- default 0 backfills every existing quote as "no uplift", which describes their
-- current pricing exactly — this migration is inert for live Marley behaviour.

alter table public.quotes
  add column additional_charges numeric(10,2) not null default 0;

alter table public.quotes
  add column additional_charges_reason text;

comment on column public.quotes.additional_charges is
  'Internal uplift folded inside the customer''s collapsed "Your Removal" line. Included in subtotal/grand_total by computeQuote(). Office/estimator only — never itemised on any customer surface.';
comment on column public.quotes.additional_charges_reason is
  'Short internal reason for the uplift (e.g. commercial access, stairs, specialist handling). Rendered on the internal QuoteView only.';

-- Self-hosted PostgREST caches the schema; without this the new columns are
-- invisible and saveQuoteDraft's update of them fails silently.
notify pgrst, 'reload schema';
