-- VAT default for new quotes. Marley is VAT-registered, so quotes should default to
-- VAT-on; this setting lets that be flipped without code. New quotes seed
-- vatEnabled from here.

alter table business_settings
  add column if not exists vat_default boolean not null default true;

comment on column business_settings.vat_default is 'Whether new quotes default to VAT enabled.';
