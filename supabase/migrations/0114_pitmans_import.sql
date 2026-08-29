-- Gate 20 — the Pitmans CSV importers.
--
-- Three things the schema does not yet allow.
--
-- 1. quotes.source is CHECK-constrained to ('marley_ops','imve'), so an
--    imported Pitmans booking cannot be written at all until 'pitmans' joins
--    it. The source is not cosmetic: lib/legacy.ts keys the money/comms lock
--    on it, so these rows must be distinguishable from ordinary Marley work
--    for the whole of their life, not just at import time.
--
-- 2. Forward bookings arrive carrying a reference from Pitmans' own books.
--    The customer-facing reference is minted fresh per brand (PMR###/PMC###,
--    gate 6), so the original needs somewhere to live that can be reconciled
--    against Mark's paperwork. It deliberately does NOT go in imve_ref: that
--    column drives the "Legacy (iMVE)" pill and the crew-paperwork
--    suppressions, so a Pitmans reference parked there would mislabel the
--    booking on /bookings and in the documents queue.
--
-- 3. Every importer tags the rows it CREATES with import_batch so
--    `--rollback <batch>` can find exactly its own work. Following 0088's
--    rule: rows an importer MATCHED rather than created are never stamped, so
--    a rollback can never delete a record that existed before the import.
--    leads and clients already carry the column; these five do not.

alter table quotes drop constraint if exists quotes_source_check;
alter table quotes
  add constraint quotes_source_check
  check (source in ('marley_ops', 'imve', 'pitmans'));

alter table quotes add column if not exists legacy_ref text;
comment on column quotes.legacy_ref is
  'Reference this job carried in the system it was imported FROM (Pitmans own books). The customer-facing reference is quote_ref, minted fresh per brand. Distinct from imve_ref, which is specific to the iMVE migration and drives the Legacy (iMVE) pill.';

alter table storage_sites add column if not exists import_batch text;
alter table storage_units add column if not exists import_batch text;
alter table storage_lets  add column if not exists import_batch text;
alter table vehicles      add column if not exists import_batch text;
alter table staff         add column if not exists import_batch text;

-- Partial: only imported rows carry a batch, and only the importers read it.
create index if not exists quotes_legacy_ref_idx
  on quotes (legacy_ref) where legacy_ref is not null;
create index if not exists storage_lets_import_batch_idx
  on storage_lets (import_batch) where import_batch is not null;
create index if not exists vehicles_import_batch_idx
  on vehicles (import_batch) where import_batch is not null;
create index if not exists staff_import_batch_idx
  on staff (import_batch) where import_batch is not null;
