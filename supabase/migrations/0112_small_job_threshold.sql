-- 0112: small-job threshold — the ask that is the whole job (multi-brand PRD §3.10
-- Addition 1, gate 9a).
--
-- When a quote's gross is at or under this figure, the acceptance ask IS the full
-- amount: one payment, no commitment, no balance, no second invoice. Above it,
-- nothing changes — the deposit/commitment/balance ladder runs exactly as it does
-- today for every brand.
--
-- The real case, 2026-08-24: a ~£120 job asked £100 at acceptance and then chased
-- a £20 balance the next day. Two invoices, two emails and a bank transfer for
-- twenty pounds. The customer was never going to experience that as anything but
-- shambolic, and it costs more to administer than it collects.
--
-- Editable rather than a constant, and sitting beside the £100 deposit default it
-- interacts with, because the right figure is a judgement about jobs rather than
-- a fact about the code. £300 is Peter's opening number (2026-08-25).
--
-- Inert on its own: nothing reads the column until gate 9a's code deploys, and
-- when it does, a threshold of 300 against a rate card whose typical job is four
-- figures changes only the small tail this exists for.

alter table public.business_settings
  add column small_job_threshold numeric(10,2) not null default 300
  constraint business_settings_small_job_threshold_valid check (small_job_threshold >= 0);

comment on column public.business_settings.small_job_threshold is
  'Gross at or under which acceptance asks for the FULL amount in one payment (no commitment, no balance). 0 disables the rule, restoring the plain deposit ladder for every job. See lib/payments-policy.ts requestedDeposit().';

-- Self-hosted PostgREST caches the schema; without this the new column is
-- invisible to the API while the SQL is provably correct.
notify pgrst, 'reload schema';
