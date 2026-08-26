-- 0108: the ledger seam — OAuth token store + the pre-cutover invoice archive
-- (docs/multi-brand-prd.md §3.4, docs/ledger-adapter-design.md §7 and §9, gate 17).
--
-- Gate 17 extracts lib/ledger/ with a Zoho adapter whose contract is ZERO
-- behaviour change, so this migration is deliberately inert for live money: it
-- creates two empty tables that nothing on any customer path reads yet. The
-- Xero adapter (gate 18) is the first writer of ledger_tokens; the snapshot
-- script is the first writer of ledger_invoice_archive, and /finance only reads
-- the archive once LEDGER_HISTORY_CUTOVER is set at the flip.
--
-- Both tables are touched exclusively by the service-role admin client. RLS is
-- enabled with NO policies (the 0041 push_subscriptions posture), so no anon or
-- authenticated token can read them — which matters most for ledger_tokens,
-- whose rows are live OAuth credentials for the real books.

-- ------------------------------------------------------------ ledger_tokens
-- Xero rotates the refresh token on EVERY use and the access token lasts 30
-- minutes (confirmed against the Xero OAuth2 spec 2026-08-26 — PRD §11.7 trap 8
-- said 60, which is wrong). Zoho by contrast never rotates, which is why
-- lib/zoho.ts can hold all its auth state in module-level per-process variables
-- and read ZOHO_REFRESH_TOKEN straight from the environment.
--
-- That difference makes env-var storage structurally impossible for Xero: the
-- moment a second container refreshes, the token in app.env is dead, and the
-- integration locks itself out with no way back except a manual re-authorise.
-- So the refresh token must live in ONE writable place, and refreshes must be
-- serialised across containers.
--
-- Serialisation is a LEASE, not a lock: PostgREST runs each call in its own
-- transaction, so `select ... for update` cannot be held across the HTTP round
-- trip to the provider. A container claims the lease with a conditional update,
-- refreshes, writes the new pair back and clears the lease. A container that
-- loses the claim waits briefly for the winner's write rather than refreshing
-- in parallel. A crashed winner is recovered by lease expiry, not by a human.
--
-- Xero's 30-minute grace on a consumed refresh token makes a genuinely raced
-- refresh survivable, but it is the safety net, not the mechanism — relying on
-- it alone would mean two containers routinely racing and only noticing when
-- the grace happened not to cover them.
create table ledger_tokens (
  provider            text primary key check (provider in ('zoho', 'xero')),

  -- The rotating credential. Stored plaintext for the same reason 0041 records:
  -- this app has no field-encryption mechanism to reuse, so RLS denial plus
  -- service-role-only access IS the control. Documented, not accidental.
  refresh_token       text not null,

  -- Cached short-lived token. Nullable: a freshly authorised org has a refresh
  -- token and no access token yet, and that is a legitimate state, not an error.
  access_token        text,
  access_expires_at   timestamptz,

  -- Which org/tenant this pair authorises. Xero calls it a tenant id and
  -- requires it on every API call; Zoho's equivalent is the org id it reads
  -- from the environment today.
  tenant_id           text,

  -- Lease. Both null means free. A claim sets both; the claimant clears them
  -- after writing the new pair back.
  refresh_lease_until timestamptz,
  refresh_lease_owner text,

  -- When the refresh token last rotated. Purely diagnostic, and the one field
  -- that answers "is this integration alive?" without calling the provider.
  rotated_at          timestamptz,
  updated_at          timestamptz not null default now()
);

alter table ledger_tokens enable row level security;

-- ---------------------------------------------------- ledger_invoice_archive
-- The pre-cutover snapshot of the outgoing provider's books.
--
-- Only ONE render-time surface reads the ledger live: /finance (listInvoices +
-- the office deep link). Every lead-history surface already reads denormalised
-- quotes.zoho_* columns from our own DB, so lead history survives the flip with
-- or without this table. What does NOT survive is /finance's view of invoices
-- raised by hand in the books, which is the whole point of that page reporting
-- the BUSINESS rather than the app.
--
-- Keyed on (provider, external_id). Deliberately NOT on invoice_number — that
-- is provider-assigned and Xero reuses the numbering space, so INV-000271 will
-- eventually mean two different documents — and NOT on reference, which is
-- non-unique by construction (three invoices per quote share MMR001 with
-- -DEP/-COM/-BAL suffixes).
create table ledger_invoice_archive (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('zoho', 'xero')),

  -- The provider's own id for the document. Frozen at capture; after the source
  -- account lapses there is nothing left to resolve it against.
  external_id   text not null,

  invoice_number text not null default '',
  -- OUR reference (MMR001-DEP). Non-unique by construction; indexed because it
  -- is how a human finds a historical invoice from a quote.
  reference     text not null default '',
  customer_name text not null default '',

  -- Invoice date (the "raised on" day /finance groups by), not capture date.
  invoice_date  date,

  -- Provider status at capture, in the app's lowercase vocabulary.
  status        text not null default '',

  -- Gross (VAT-inclusive) total and unpaid remainder, exactly as /finance reads
  -- them from a live row.
  total         numeric(12,2) not null default 0,
  balance       numeric(12,2) not null default 0,

  -- Audit only — NEVER rendered. /finance derives VAT app-side via
  -- invoiceVat()/vatFromGross() against the VAT_REGISTERED_FROM = 2026-06-01
  -- floor. Rendering a stored VAT figure beside live rows that derive theirs
  -- would create two sources of truth for the same column on the same page, and
  -- they would diverge silently. Captured so the figure can be RECONCILED
  -- later, not so it can be displayed.
  provider_tax_total numeric(12,2),

  -- The office deep link, FROZEN at capture rather than reconstructed. The
  -- constructor is Zoho-shaped and reads ZOHO_ORG_ID, which is removed from
  -- app.env at decommission — after which every reconstructed link would
  -- silently point at a broken page while still looking like a link.
  app_url       text,

  -- Brand attribution, or NULL. Extracted with the bank-feed reference shape
  -- (MM|PM)[RC]\d{3,} rather than a ref_prefix startsWith: storage references
  -- are MMS-... with no brand input at all (lib/storage-billing.ts), so a prefix
  -- compare attributes EVERY storage invoice — Pitmans lets included — to
  -- Marley, and the result looks right. NULL means "not confidently attributed"
  -- and must get its own visible bucket wherever this is grouped; ambiguity
  -- yields nothing, never a best guess.
  brand         text references brands(slug),

  captured_at   timestamptz not null default now(),

  unique (provider, external_id)
);

create index ledger_invoice_archive_date_idx on ledger_invoice_archive (invoice_date desc);
create index ledger_invoice_archive_reference_idx on ledger_invoice_archive (reference);
create index ledger_invoice_archive_brand_idx on ledger_invoice_archive (brand);

alter table ledger_invoice_archive enable row level security;

notify pgrst, 'reload schema';
