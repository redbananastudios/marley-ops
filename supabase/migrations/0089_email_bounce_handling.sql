-- Bounce / complaint handling.
--
-- Until now the inbound webhook dropped every Resend event that was not
-- 'email.received', so a hard bounce was invisible. Resend accepts a send to a
-- mistyped address with a 200, we stamp the row 'sent', and the quote email plus
-- all three chases and both deposit reminders are recorded as delivered. Every
-- one bounces asynchronously and nothing anywhere notices — then at day 30 the
-- chase cron marks the lead declined / 'no_response', a false loss reason for
-- someone who never received a single message.
--
-- Two facts to record: which SEND bounced (evidence, on communications) and
-- whether the LEAD's address is now known-bad (the operational signal).
-- Deliberately NOT a new comm_status enum value: adding one is a schema-wide
-- change that every status reader would need to learn, and 'sent' remains true —
-- the provider did accept it. The bounce is a later, separate fact.

alter table communications
  add column if not exists bounced_at timestamptz,
  -- 'hard' | 'soft' | 'complaint' — kept as free text so a new Resend bounce
  -- classification can land without a migration.
  add column if not exists bounce_kind text;

alter table leads
  -- Set when a message to this lead hard-bounces or the recipient complains;
  -- cleared by the office when the address is corrected. Its presence means
  -- "do not trust this address" — the chase engine is kept away from these
  -- leads via chase_paused (set at the same moment), so they can neither be
  -- emailed into a void nor auto-lapsed to a false 'no_response'.
  add column if not exists email_invalid_at timestamptz,
  add column if not exists email_invalid_reason text;

-- Finding the communication a Resend bounce refers to means looking it up by
-- the provider's email id; without this that is a full scan of a table that
-- grows with every message ever sent.
create index if not exists communications_provider_id_idx
  on communications (provider_id)
  where provider_id is not null;

-- The office's "bad address" queue: open leads whose email is known-bad.
create index if not exists leads_email_invalid_idx
  on leads (email_invalid_at)
  where email_invalid_at is not null;

notify pgrst, 'reload schema';
