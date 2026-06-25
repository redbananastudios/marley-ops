-- Client full address + company + extended contact fields.
-- The clients table is the dedupe target and the source of truth for an address
-- that flows through the whole system (leads, quotes, surveys). Structured, separated
-- fields give conformity everywhere rather than one free-text postcode.

alter table clients
  -- company vs individual
  add column if not exists is_company       boolean not null default false,
  add column if not exists company_name     text,
  add column if not exists business_number  text,
  -- split name (display_name stays the resolved label: company name, else "First Last")
  add column if not exists first_name        text,
  add column if not exists last_name         text,
  -- extra contact
  add column if not exists alt_phone         text,
  add column if not exists secondary_emails  text[] not null default '{}',
  -- structured address (postcode_home remains the canonical postcode column)
  add column if not exists address_line1     text,
  add column if not exists town              text,
  add column if not exists county            text,
  add column if not exists country           text not null default 'United Kingdom';

comment on column clients.address_line1 is 'Street address (house/number + street).';
comment on column clients.town is 'Post town / city.';
comment on column clients.county is 'County (admin area).';
comment on column clients.country is 'Country; defaults to United Kingdom.';
comment on column clients.secondary_emails is 'Additional email addresses beyond the primary email.';
