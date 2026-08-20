-- One lead per website submission, whichever route delivered it.
--
-- The site now posts enquiries straight to /api/ingest/lead and retries up to
-- three times. The route checks for the submission id before inserting, but a
-- check-then-insert is not atomic: an attempt that times out on the caller's
-- side while still committing on ours overlaps the retry, both read "not there
-- yet", and the customer lands twice. This index is the part that cannot race —
-- the second insert violates it and the route adopts the winning row instead.
--
-- `external_lead_id` (present since 0001, never written until now) holds the id
-- the SITE minted, deliberately NOT `sanity_id`, which names a Sanity document
-- and is set by Sanity. Two writers sharing one column with different id spaces
-- would be a duplicate factory the moment both delivery routes run at once;
-- separate columns let a row carry both keys and let either route recognise the
-- other's work. The site stamps the same id onto its Sanity document, so the
-- sync matches on it too.
--
-- Partial: NULLs never collide, so every lead that did not come from the
-- website (phone, walk-in, referral, the iMVE import) is unaffected.

create unique index if not exists leads_external_lead_uq
  on leads(external_lead_id)
  where external_lead_id is not null;
