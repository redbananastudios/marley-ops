-- Marley Moves is VAT registered — the number must appear on customer paperwork.
-- Rendered in the quote PDF footer (and anywhere else legal copy needs it).
alter table business_settings add column if not exists vat_number text;
