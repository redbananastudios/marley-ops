-- Store the exact provider request on each outbound communication so a failed
-- send can be re-driven by the comms-retry worker with the SAME idempotency key
-- (marley-comm/<id>). Without the stored payload the worker would have to
-- reconstruct the request from the lossy display columns (no html/template,
-- no attachment bytes, no replyTo/from) — and any drift changes the payload
-- hash, which both breaks Resend's idempotency dedupe and trips the reclaim
-- payload-hash guard. The transactional-outbox pattern: the row IS the outbox.
--
-- Nullable: pre-existing rows never get one, and the worker only retries rows
-- that HAVE a provider_request, so old failed rows are simply left alone.

begin;

alter table public.communications
  add column if not exists provider_request jsonb;

notify pgrst, 'reload schema';

commit;
