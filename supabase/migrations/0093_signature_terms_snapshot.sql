-- 0093: capture WHAT the customer agreed to, not just a label for it.
--
-- signatures.terms_version already existed, but it held a hand-maintained
-- constant (`generic-v1-2026-07-10`) that did not correspond to any real
-- document — the terms it named were dated 16 June 2026 and lived as hardcoded
-- JSX on the website, edited in place. So we could name a version and not
-- produce it. For a signature, which exists to be produced years later to an
-- insurer or a court, that is the whole value gone.
--
-- From here a signature carries its own evidence and depends on nothing
-- external surviving:
--   terms_sha256           digest of the exact body agreed to (tamper check
--                          against legal/manifest.json)
--   terms_snapshot         the full text. A few KB per row; the UK limitation
--                          period for contract claims is six years, and a row
--                          that needs a file to still exist in 2032 to mean
--                          anything is not evidence.
--   acknowledgment_labels  the tick WORDING. `acknowledgments` stores keys only
--                          ({"inventory": true}), so rewording an ack silently
--                          rewrote what every historical signature appeared to
--                          have agreed to.
--
-- Nullable and no backfill here: existing rows are mapped by
-- scripts/backfill-signature-terms.mjs, which resolves each signature to the
-- version that was live on the day it was signed rather than assuming today's.

alter table signatures add column if not exists terms_sha256          text;
alter table signatures add column if not exists terms_snapshot        text;
alter table signatures add column if not exists acknowledgment_labels jsonb;

comment on column signatures.terms_version is
  'Published version id from legal/manifest.json, e.g. customer-terms-v2-2026-08-11.';
comment on column signatures.terms_sha256 is
  'SHA-256 of terms_snapshot. Must match the manifest entry for terms_version.';
comment on column signatures.terms_snapshot is
  'Full text of the terms as served at signing. Immutable evidence.';
comment on column signatures.acknowledgment_labels is
  'key -> the exact wording of each tick-box at signing (acknowledgments holds keys only).';

-- Evidence rows are append-only (0025: no update policy, delete is admin-only),
-- so nothing further is needed to protect these from later edits.
