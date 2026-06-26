-- Editable quote prices. Stored as JSON so the van/7.5t price grid can be tuned from
-- Settings without a code change. NULL = use the code defaults (DEFAULT_PRICING); the
-- settings form writes the full editable subset (base + pack per van + 7.5t base/pack).

alter table business_settings
  add column if not exists pricing jsonb;

comment on column business_settings.pricing is 'Editable quote prices (base + pack per van tier + 7.5t base/pack). NULL falls back to code defaults.';
