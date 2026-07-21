-- Delivery idempotency and durable operational issue tracking.
--
-- Customer communications and verified inbound webhooks must claim durable
-- work before contacting providers or writing side effects. Operational issues
-- are keyed, counted, resolved, and snapshotted daily by the existing watchdog.

begin;

-- ---------------------------------------------------------------------------
-- Outbound communication claims.

alter table public.communications
  add column if not exists dispatch_key text,
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists provider_started_at timestamptz,
  add column if not exists provider_payload_hash text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists provider_outcome_unknown boolean not null default false;

-- Preserve the historical audit timestamp while backfilling the new key.
alter table public.communications disable trigger trg_communications_updated;
update public.communications
set dispatch_key = content_hash
where status = 'sent'
  and not is_override
  and dispatch_key is null;
alter table public.communications enable trigger trg_communications_updated;

create unique index if not exists communications_dispatch_key_uq
  on public.communications(dispatch_key)
  where not is_override and dispatch_key is not null;

create index if not exists communications_claim_expiry_idx
  on public.communications(claim_expires_at)
  where status = 'queued' and claim_expires_at is not null;

drop function if exists public.reclaim_communication_send(uuid, uuid, uuid, integer);
create or replace function public.reclaim_communication_send(
  p_id uuid,
  p_old_claim_token uuid,
  p_new_claim_token uuid,
  p_provider_payload_hash text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_office() then
    raise exception 'Office access required' using errcode = '42501';
  end if;

  update public.communications
  set status = 'queued',
      claim_token = p_new_claim_token,
      claim_expires_at = now() + pg_catalog.make_interval(secs => p_lease_seconds),
      provider_id = null,
      provider_error = null,
      provider_outcome_unknown = false,
      attempt_count = attempt_count + 1
  where id = p_id
    and claim_token = p_old_claim_token
    and provider_payload_hash = p_provider_payload_hash
    and (
      status = 'failed'
      or (status = 'queued' and claim_expires_at <= now())
    )
    and (
      provider_started_at is null
      or (
        channel = 'email'
        and provider_started_at > now() - pg_catalog.make_interval(hours => 23)
      )
    );

  return found;
end;
$function$;

create or replace function public.start_communication_provider(
  p_id uuid,
  p_claim_token uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_office() then
    raise exception 'Office access required' using errcode = '42501';
  end if;

  update public.communications
  set provider_started_at = coalesce(provider_started_at, now())
  where id = p_id
    and status = 'queued'
    and claim_token = p_claim_token
    and claim_expires_at > now()
  returning provider_started_at into v_started_at;

  return v_started_at;
end;
$function$;

create or replace function public.finalize_communication_send(
  p_id uuid,
  p_claim_token uuid,
  p_provider_id text,
  p_sent_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_quote_id uuid;
  v_channel public.comm_channel;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_office() then
    raise exception 'Office access required' using errcode = '42501';
  end if;

  update public.communications
  set status = 'sent',
      provider_id = nullif(p_provider_id, ''),
      provider_error = null,
      provider_outcome_unknown = false,
      send_count = send_count + 1,
      first_sent_at = coalesce(first_sent_at, p_sent_at),
      last_sent_at = p_sent_at,
      claim_token = null,
      claim_expires_at = null
  where id = p_id
    and status = 'queued'
    and claim_token = p_claim_token
  returning quote_id, channel into v_quote_id, v_channel;

  if not found then
    return false;
  end if;

  if v_quote_id is not null and v_channel = 'email' then
    update public.quotes
    set email_sent = true,
        email_sent_at = coalesce(email_sent_at, p_sent_at),
        email_message_id = nullif(p_provider_id, ''),
        email_send_count = email_send_count + 1
    where id = v_quote_id;
  elsif v_quote_id is not null and v_channel = 'sms' then
    update public.quotes
    set sms_send_count = sms_send_count + 1
    where id = v_quote_id;
  end if;

  return true;
end;
$function$;

revoke all on function public.reclaim_communication_send(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.start_communication_provider(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_communication_send(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reclaim_communication_send(uuid, uuid, uuid, text, integer)
  to authenticated, service_role;
grant execute on function public.start_communication_provider(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.finalize_communication_send(uuid, uuid, text, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verified webhook replay claims.

create table if not exists public.webhook_receipts (
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload_hash text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  attempt_count integer not null default 1,
  lease_token uuid,
  lease_expires_at timestamptz,
  outcome jsonb not null default '{}'::jsonb,
  last_error text,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (provider, event_id)
);

create index if not exists webhook_receipts_status_lease_idx
  on public.webhook_receipts(status, lease_expires_at);

alter table public.webhook_receipts enable row level security;
drop policy if exists webhook_receipts_read on public.webhook_receipts;
create policy webhook_receipts_read on public.webhook_receipts
  for select using (public.is_office());

create table if not exists public.webhook_delivery_steps (
  provider text not null,
  event_id text not null,
  step text not null,
  status text not null default 'started' check (status in ('started', 'completed')),
  provider_started_at timestamptz not null default now(),
  provider_completed_at timestamptz,
  provider_id text,
  payload_hash text not null default '',
  primary key (provider, event_id, step),
  foreign key (provider, event_id)
    references public.webhook_receipts(provider, event_id) on delete cascade
);

alter table public.webhook_delivery_steps
  add column if not exists payload_hash text not null default '';

alter table public.webhook_delivery_steps enable row level security;
drop policy if exists webhook_delivery_steps_read on public.webhook_delivery_steps;
create policy webhook_delivery_steps_read on public.webhook_delivery_steps
  for select using (public.is_office());

-- Database backstops for side effects that precede receipt completion.
create unique index if not exists follow_ups_inbound_event_uq
  on public.follow_ups ((metadata ->> 'inbound_event_id'))
  where source = 'inbound_reply' and metadata ? 'inbound_event_id';
create unique index if not exists activities_inbound_event_uq
  on public.activities ((meta ->> 'inbound_event_id'))
  where meta ? 'inbound_event_id';

create or replace function public.claim_webhook_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload_hash text,
  p_lease_seconds integer default 300
)
returns table(decision text, lease_token uuid, attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
  v_token uuid := gen_random_uuid();
  v_row public.webhook_receipts%rowtype;
begin
  insert into public.webhook_receipts (
    provider, event_id, event_type, payload_hash, status,
    attempt_count, lease_token, lease_expires_at
  ) values (
    p_provider, p_event_id, p_event_type, p_payload_hash, 'processing',
    1, v_token, v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  )
  on conflict (provider, event_id) do nothing;

  if found then
    return query select 'claimed'::text, v_token, 1;
    return;
  end if;

  select * into v_row
  from public.webhook_receipts
  where provider = p_provider and event_id = p_event_id
  for update;

  if v_row.payload_hash <> p_payload_hash then
    return query select 'payload_mismatch'::text, null::uuid, v_row.attempt_count;
    return;
  elsif v_row.status = 'completed' then
    return query select 'completed'::text, null::uuid, v_row.attempt_count;
    return;
  elsif v_row.status = 'processing' and v_row.lease_expires_at > v_now then
    return query select 'busy'::text, null::uuid, v_row.attempt_count;
    return;
  end if;

  update public.webhook_receipts as receipt
  set event_type = p_event_type,
      status = 'processing',
      attempt_count = receipt.attempt_count + 1,
      lease_token = v_token,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      last_received_at = v_now,
      last_error = null
  where provider = p_provider and event_id = p_event_id
  returning receipt.attempt_count into v_row.attempt_count;

  return query select 'claimed'::text, v_token, v_row.attempt_count;
end;
$function$;

create or replace function public.complete_webhook_event(
  p_provider text,
  p_event_id text,
  p_lease_token uuid,
  p_outcome jsonb default '{}'::jsonb
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with updated as (
    update public.webhook_receipts
    set status = 'completed',
        outcome = p_outcome,
        completed_at = now(),
        lease_expires_at = null,
        last_error = null
    where provider = p_provider
      and event_id = p_event_id
      and status = 'processing'
      and lease_token = p_lease_token
    returning 1
  )
  select pg_catalog.count(*) > 0 from updated;
$function$;

create or replace function public.fail_webhook_event(
  p_provider text,
  p_event_id text,
  p_lease_token uuid,
  p_error text
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with updated as (
    update public.webhook_receipts
    set status = 'failed',
        last_error = pg_catalog.left(p_error, 1000),
        lease_expires_at = null
    where provider = p_provider
      and event_id = p_event_id
      and status = 'processing'
      and lease_token = p_lease_token
    returning 1
  )
  select pg_catalog.count(*) > 0 from updated;
$function$;

drop function if exists public.claim_webhook_delivery_step(text, text, uuid, text);
create or replace function public.claim_webhook_delivery_step(
  p_provider text,
  p_event_id text,
  p_lease_token uuid,
  p_step text,
  p_payload_hash text
)
returns table(decision text, provider_started_at timestamptz, provider_id text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row public.webhook_delivery_steps%rowtype;
begin
  if p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid provider payload hash';
  end if;

  perform 1 from public.webhook_receipts receipt
    where receipt.provider = p_provider
      and receipt.event_id = p_event_id
      and receipt.status = 'processing'
      and receipt.lease_token = p_lease_token
      and receipt.lease_expires_at > now()
    for update;
  if not found then
    return query select 'lease_lost'::text, null::timestamptz, null::text;
    return;
  end if;

  insert into public.webhook_delivery_steps (provider, event_id, step, payload_hash)
  values (p_provider, p_event_id, p_step, p_payload_hash)
  on conflict (provider, event_id, step) do nothing;
  if found then
    select * into v_row from public.webhook_delivery_steps
    where provider = p_provider and event_id = p_event_id and step = p_step;
    return query select 'send'::text, v_row.provider_started_at, v_row.provider_id;
    return;
  end if;

  select * into v_row from public.webhook_delivery_steps
  where provider = p_provider and event_id = p_event_id and step = p_step
  for update;
  if v_row.status = 'completed' then
    return query select 'completed'::text, v_row.provider_started_at, v_row.provider_id;
    return;
  elsif v_row.payload_hash <> p_payload_hash then
    return query select 'payload_mismatch'::text, v_row.provider_started_at, v_row.provider_id;
    return;
  elsif v_row.provider_started_at > now() - pg_catalog.make_interval(hours => 23) then
    return query select 'retry_safe'::text, v_row.provider_started_at, v_row.provider_id;
    return;
  end if;

  return query select 'manual_review'::text, v_row.provider_started_at, v_row.provider_id;
end;
$function$;

create or replace function public.fail_webhook_delivery_step(
  p_provider text,
  p_event_id text,
  p_lease_token uuid,
  p_step text,
  p_outcome_unknown boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_outcome_unknown then
    return true;
  end if;

  delete from public.webhook_delivery_steps delivery
  where delivery.provider = p_provider
    and delivery.event_id = p_event_id
    and delivery.step = p_step
    and exists (
      select 1 from public.webhook_receipts receipt
      where receipt.provider = p_provider
        and receipt.event_id = p_event_id
        and receipt.status = 'processing'
        and receipt.lease_token = p_lease_token
        and receipt.lease_expires_at > now()
    );
  return found;
end;
$function$;

create or replace function public.complete_webhook_delivery_step(
  p_provider text,
  p_event_id text,
  p_step text,
  p_provider_id text
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with updated as (
    update public.webhook_delivery_steps
    set status = 'completed',
        provider_completed_at = now(),
        provider_id = p_provider_id
    where provider = p_provider and event_id = p_event_id and step = p_step
    returning 1
  )
  select pg_catalog.count(*) > 0 from updated;
$function$;

revoke all on function public.claim_webhook_event(text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_event(text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_event(text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_webhook_delivery_step(text, text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_delivery_step(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_delivery_step(text, text, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_webhook_event(text, text, text, text, integer) to service_role;
grant execute on function public.complete_webhook_event(text, text, uuid, jsonb) to service_role;
grant execute on function public.fail_webhook_event(text, text, uuid, text) to service_role;
grant execute on function public.claim_webhook_delivery_step(text, text, uuid, text, text) to service_role;
grant execute on function public.complete_webhook_delivery_step(text, text, text, text) to service_role;
grant execute on function public.fail_webhook_delivery_step(text, text, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Durable, structured operational issues and one daily checkpoint per issue.

create table if not exists public.operational_issues (
  id uuid primary key default gen_random_uuid(),
  issue_key text not null unique,
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  source text not null,
  event text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  occurrence_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_checkpoint_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists operational_issues_open_idx
  on public.operational_issues(severity, last_seen_at desc)
  where status = 'open';

drop trigger if exists trg_operational_issues_updated on public.operational_issues;
create trigger trg_operational_issues_updated
  before update on public.operational_issues
  for each row execute function public.set_updated_at();

alter table public.operational_issues enable row level security;
drop policy if exists operational_issues_read on public.operational_issues;
create policy operational_issues_read on public.operational_issues
  for select using (public.is_office());

create table if not exists public.operational_issue_daily_updates (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.operational_issues(id) on delete cascade,
  snapshot_date date not null,
  severity text not null,
  status text not null,
  occurrence_count integer not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, snapshot_date)
);

create index if not exists operational_issue_daily_updates_date_idx
  on public.operational_issue_daily_updates(snapshot_date desc);

drop trigger if exists trg_operational_issue_daily_updates_updated
  on public.operational_issue_daily_updates;
create trigger trg_operational_issue_daily_updates_updated
  before update on public.operational_issue_daily_updates
  for each row execute function public.set_updated_at();

alter table public.operational_issue_daily_updates enable row level security;
drop policy if exists operational_issue_daily_updates_read
  on public.operational_issue_daily_updates;
create policy operational_issue_daily_updates_read
  on public.operational_issue_daily_updates for select using (public.is_office());

create table if not exists public.operational_issue_daily_digests (
  snapshot_date date primary key,
  issue_count integer not null default 0,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  claim_token uuid,
  claim_expires_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null default '',
  provider_error text,
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.operational_issue_daily_digests
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists payload_hash text not null default '';

alter table public.operational_issue_daily_digests
  drop constraint if exists operational_issue_daily_digests_status_check;
alter table public.operational_issue_daily_digests
  add constraint operational_issue_daily_digests_status_check
  check (status in ('pending', 'sent', 'failed', 'simulated'));

drop trigger if exists trg_operational_issue_daily_digests_updated
  on public.operational_issue_daily_digests;
create trigger trg_operational_issue_daily_digests_updated
  before update on public.operational_issue_daily_digests
  for each row execute function public.set_updated_at();

alter table public.operational_issue_daily_digests enable row level security;
drop policy if exists operational_issue_daily_digests_read
  on public.operational_issue_daily_digests;
create policy operational_issue_daily_digests_read
  on public.operational_issue_daily_digests for select using (public.is_office());

create or replace function public.claim_operational_issue_digest(
  p_snapshot_date date,
  p_issue_count integer,
  p_payload jsonb,
  p_payload_hash text,
  p_retry_simulated boolean default false,
  p_lease_seconds integer default 300
)
returns table (
  decision text,
  digest_claim_token uuid,
  digest_payload jsonb,
  digest_issue_count integer,
  digest_attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_digest public.operational_issue_daily_digests%rowtype;
  v_token uuid := pg_catalog.gen_random_uuid();
begin
  if p_issue_count < 1 then
    raise exception 'Digest issue count must be positive';
  end if;

  insert into public.operational_issue_daily_digests (
    snapshot_date, issue_count, status, attempt_count, claim_token,
    claim_expires_at, payload, payload_hash, provider_error
  ) values (
    p_snapshot_date,
    p_issue_count,
    'pending',
    1,
    v_token,
    now() + pg_catalog.make_interval(secs => greatest(30, p_lease_seconds)),
    coalesce(p_payload, '{}'::jsonb),
    pg_catalog.left(coalesce(p_payload_hash, ''), 128),
    null
  )
  on conflict (snapshot_date) do nothing
  returning * into v_digest;

  if v_digest.snapshot_date is not null then
    return query select
      'claimed'::text,
      v_digest.claim_token,
      v_digest.payload,
      v_digest.issue_count,
      v_digest.attempt_count;
    return;
  end if;

  select * into v_digest
  from public.operational_issue_daily_digests
  where snapshot_date = p_snapshot_date
  for update;

  if v_digest.status = 'sent' then
    return query select 'sent'::text, null::uuid, v_digest.payload, v_digest.issue_count, v_digest.attempt_count;
    return;
  end if;

  if v_digest.status = 'simulated' and not p_retry_simulated then
    return query select 'simulated'::text, null::uuid, v_digest.payload, v_digest.issue_count, v_digest.attempt_count;
    return;
  end if;

  if v_digest.status = 'pending'
     and v_digest.claim_token is not null
     and v_digest.claim_expires_at > now() then
    return query select 'busy'::text, null::uuid, v_digest.payload, v_digest.issue_count, v_digest.attempt_count;
    return;
  end if;

  update public.operational_issue_daily_digests
  set status = 'pending',
      attempt_count = attempt_count + 1,
      claim_token = v_token,
      claim_expires_at = now() + pg_catalog.make_interval(secs => greatest(30, p_lease_seconds)),
      provider_error = null
  where snapshot_date = p_snapshot_date
  returning * into v_digest;

  return query select
    'claimed'::text,
    v_digest.claim_token,
    v_digest.payload,
    v_digest.issue_count,
    v_digest.attempt_count;
end;
$function$;

create or replace function public.complete_operational_issue_digest(
  p_snapshot_date date,
  p_claim_token uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with completed as (
    update public.operational_issue_daily_digests
    set status = 'sent',
        sent_at = now(),
        provider_error = null,
        claim_token = null,
        claim_expires_at = null
    where snapshot_date = p_snapshot_date
      and status = 'pending'
      and claim_token = p_claim_token
    returning 1
  )
  select exists(select 1 from completed);
$function$;

create or replace function public.fail_operational_issue_digest(
  p_snapshot_date date,
  p_claim_token uuid,
  p_error text
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with failed as (
    update public.operational_issue_daily_digests
    set status = 'failed',
        provider_error = pg_catalog.left(p_error, 1000),
        claim_token = null,
        claim_expires_at = null
    where snapshot_date = p_snapshot_date
      and status = 'pending'
      and claim_token = p_claim_token
    returning 1
  )
  select exists(select 1 from failed);
$function$;

create or replace function public.simulate_operational_issue_digest(
  p_snapshot_date date,
  p_claim_token uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with simulated as (
    update public.operational_issue_daily_digests
    set status = 'simulated',
        sent_at = null,
        provider_error = null,
        claim_token = null,
        claim_expires_at = null
    where snapshot_date = p_snapshot_date
      and status = 'pending'
      and claim_token = p_claim_token
    returning 1
  )
  select exists(select 1 from simulated);
$function$;

create or replace function public.report_operational_issue(
  p_issue_key text,
  p_severity text,
  p_source text,
  p_event text,
  p_message text,
  p_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if p_severity not in ('info', 'warning', 'error', 'critical') then
    raise exception 'Invalid issue severity';
  end if;

  insert into public.operational_issues (
    issue_key, severity, source, event, message, context
  ) values (
    p_issue_key, p_severity, p_source, p_event, pg_catalog.left(p_message, 1000), p_context
  )
  on conflict (issue_key) do update
  set severity = excluded.severity,
      source = excluded.source,
      event = excluded.event,
      message = excluded.message,
      context = excluded.context,
      status = 'open',
      occurrence_count = operational_issues.occurrence_count + 1,
      last_seen_at = now(),
      resolved_at = null
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.resolve_operational_issue(p_issue_key text)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with resolved as (
    update public.operational_issues
    set status = 'resolved', resolved_at = now()
    where issue_key = p_issue_key and status = 'open'
    returning id
  ), snapshot as (
    update public.operational_issue_daily_updates daily
    set status = 'resolved'
    from resolved
    where daily.issue_id = resolved.id
      and daily.snapshot_date = (now() at time zone 'Europe/London')::date
    returning 1
  )
  select pg_catalog.count(*) > 0 from resolved;
$function$;

create or replace function public.checkpoint_operational_issues(p_snapshot_date date)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  with open_issues as materialized (
    select id, severity, status, occurrence_count, context
    from public.operational_issues
    where status = 'open'
    for update
  ), snapshotted as (
    insert into public.operational_issue_daily_updates (
      issue_id, snapshot_date, severity, status, occurrence_count, context
    )
    select id, p_snapshot_date, severity, status, occurrence_count, context
    from open_issues
    on conflict (issue_id, snapshot_date) do update
    set severity = excluded.severity,
        status = excluded.status,
        occurrence_count = excluded.occurrence_count,
        context = excluded.context
    returning issue_id
  ), checkpointed as (
    update public.operational_issues issue
    set last_checkpoint_at = now()
    from snapshotted
    where issue.id = snapshotted.issue_id
    returning 1
  )
  select pg_catalog.count(*) into v_count from checkpointed;

  return v_count;
end;
$function$;

revoke all on function public.report_operational_issue(text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.resolve_operational_issue(text)
  from public, anon, authenticated;
revoke all on function public.checkpoint_operational_issues(date)
  from public, anon, authenticated;
revoke all on function public.claim_operational_issue_digest(date, integer, jsonb, text, boolean, integer)
  from public, anon, authenticated;
revoke all on function public.complete_operational_issue_digest(date, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_operational_issue_digest(date, uuid, text)
  from public, anon, authenticated;
revoke all on function public.simulate_operational_issue_digest(date, uuid)
  from public, anon, authenticated;
grant execute on function public.report_operational_issue(text, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.resolve_operational_issue(text) to service_role;
grant execute on function public.checkpoint_operational_issues(date) to service_role;
grant execute on function public.claim_operational_issue_digest(date, integer, jsonb, text, boolean, integer)
  to service_role;
grant execute on function public.complete_operational_issue_digest(date, uuid) to service_role;
grant execute on function public.fail_operational_issue_digest(date, uuid, text) to service_role;
grant execute on function public.simulate_operational_issue_digest(date, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
