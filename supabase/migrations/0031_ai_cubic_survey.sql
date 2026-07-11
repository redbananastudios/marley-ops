-- 0031: AI-assisted cubic survey domain, persistence and atomic boundaries.
-- V1 is estimator/office only. Authenticated users may read AI state, but all
-- mutations run through validated service-role actions/RPCs. Provider-specific
-- object-storage provisioning is deliberately isolated in migration 0032.

-- ---------------------------------------------------------------------------
-- Settings and canonical survey state

alter table public.business_settings
  add column if not exists ai_survey_enabled boolean not null default false,
  add column if not exists ai_grounded_replay_enabled boolean not null default false,
  add column if not exists ai_model_default text not null default 'gemini-3.5-flash',
  add column if not exists ai_model_escalation text not null default 'gemini-3.5-flash',
  add column if not exists ai_survey_cap_gbp numeric(6,2) not null default 2,
  add column if not exists ai_monthly_cap_gbp numeric(8,2) not null default 50,
  add column if not exists ai_monthly_alert_gbp numeric(8,2) not null default 40;

alter table public.business_settings
  add constraint business_settings_ai_model_default_ck
    check (ai_model_default in ('gemini-3.5-flash', 'gemini-3.1-flash-lite')),
  add constraint business_settings_ai_model_escalation_ck
    check (ai_model_escalation in ('gemini-3.5-flash', 'gemini-3.1-flash-lite')),
  add constraint business_settings_ai_caps_ck
    check (
      ai_survey_cap_gbp > 0
      and ai_monthly_cap_gbp > 0
      and ai_monthly_alert_gbp >= 0
      and ai_monthly_alert_gbp <= ai_monthly_cap_gbp
    );

alter table public.cubic_surveys
  add column if not exists contingency_pct int not null default 0,
  add column if not exists ai_consent jsonb,
  add column if not exists legal_hold boolean not null default false,
  add column if not exists ai_status text not null default 'not_started',
  add column if not exists planning_ready boolean not null default false,
  add column if not exists room_manifest_complete boolean not null default false,
  add column if not exists ai_abandoned_at timestamptz,
  add column if not exists ai_consent_withdrawn_at timestamptz,
  add column if not exists ai_consent_withdrawn_by uuid references public.profiles(id) on delete set null,
  add column if not exists last_ai_user_activity_at timestamptz,
  add column if not exists media_retention_anchor_at timestamptz;

alter table public.cubic_surveys
  add constraint cubic_surveys_contingency_pct_ck
    check (contingency_pct in (0, 10, 20, 30)),
  add constraint cubic_surveys_ai_status_ck
    check (ai_status in ('not_started', 'active', 'ready', 'complete', 'abandoned', 'failed')),
  add constraint cubic_surveys_ai_consent_ck
    check (ai_consent is null or jsonb_typeof(ai_consent) = 'object');

-- Existing lines used their catalogue key as UI identity. Give every legacy
-- line an immutable UUID without changing array order or otherwise rewriting it.
update public.cubic_surveys as survey
set items = (
  select coalesce(
    jsonb_agg(
      case
        when jsonb_typeof(line.value -> 'id') = 'string'
          and (line.value ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then line.value
        else line.value || jsonb_build_object('id', gen_random_uuid()::text)
      end
      order by line.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(survey.items) with ordinality as line(value, ordinality)
)
where jsonb_typeof(survey.items) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(survey.items) as existing(value)
    where jsonb_typeof(existing.value -> 'id') <> 'string'
       or (existing.value ->> 'id') is null
       or (existing.value ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

-- cubic_surveys previously used is_staff(), which includes crew. AI consent
-- and legal/retention state are office-only; crew volume is loaded separately
-- through the existing price-free service-role loader.
drop policy if exists cubic_surveys_read on public.cubic_surveys;
drop policy if exists cubic_surveys_insert on public.cubic_surveys;
drop policy if exists cubic_surveys_update on public.cubic_surveys;
drop policy if exists cubic_surveys_delete on public.cubic_surveys;
create policy cubic_surveys_office_read on public.cubic_surveys
  for select using (public.is_office());

revoke all on table public.cubic_surveys from anon, authenticated;
grant select on table public.cubic_surveys to authenticated;
grant all on table public.cubic_surveys to service_role;

-- ---------------------------------------------------------------------------
-- Capture and processing tables

create table public.cubic_survey_rooms (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  room_type text check (room_type is null or char_length(room_type) <= 60),
  floor text check (floor is null or char_length(floor) <= 60),
  sort int not null default 0,
  hidden_storage_checked boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'needs_attention', 'ready', 'confirmed', 'failed')),
  coverage text check (coverage in ('good', 'partial', 'poor')),
  quality_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(quality_flags) = 'array'),
  quality_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(quality_warnings) = 'array'),
  completion_method text check (completion_method in ('ai', 'manual')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (survey_id, id)
);

create table public.cubic_survey_media (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  room_id uuid,
  kind text not null check (kind in ('room_video', 'import_video', 'photo')),
  storage_path text not null unique,
  mime text not null check (char_length(mime) between 1 and 120),
  bytes bigint check (bytes is null or bytes between 0 and 524288000),
  duration_s numeric(8,1) check (duration_s is null or duration_s between 0 and 1200),
  frames jsonb not null default '[]'::jsonb check (jsonb_typeof(frames) = 'array'),
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'processing', 'processed', 'failed', 'ignored', 'deletion_pending', 'deleted')),
  coverage text check (coverage in ('good', 'partial', 'poor')),
  quality_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(quality_flags) = 'array'),
  error text,
  finalized_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (survey_id, id),
  foreign key (survey_id, room_id)
    references public.cubic_survey_rooms(survey_id, id) on delete set null (room_id),
  check (
    storage_path = survey_id::text || '/' || id::text || '/source.mp4'
    or storage_path = survey_id::text || '/' || id::text || '/source.mov'
    or storage_path = survey_id::text || '/' || id::text || '/source.webm'
    or storage_path = survey_id::text || '/' || id::text || '/source.jpg'
    or storage_path = survey_id::text || '/' || id::text || '/source.jpeg'
    or storage_path = survey_id::text || '/' || id::text || '/source.png'
  )
);

create table public.cubic_survey_segments (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  media_id uuid not null,
  model_ref text not null check (char_length(model_ref) between 1 and 40),
  proposed_name text not null check (char_length(btrim(proposed_name)) between 1 and 60),
  start_s numeric(8,2) not null check (start_s >= 0),
  end_s numeric(8,2) not null check (end_s > start_s),
  room_id uuid,
  status text not null default 'proposed'
    check (status in ('proposed', 'assigned', 'merged', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (survey_id, id),
  unique (media_id, model_ref),
  foreign key (survey_id, media_id)
    references public.cubic_survey_media(survey_id, id) on delete cascade,
  foreign key (survey_id, room_id)
    references public.cubic_survey_rooms(survey_id, id) on delete set null (room_id)
);

create table public.cubic_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  media_id uuid,
  model text not null check (model in ('gemini-3.5-flash', 'gemini-3.1-flash-lite')),
  prompt_version text not null check (char_length(prompt_version) between 1 and 80),
  purpose text not null check (purpose in ('itemise', 'escalation', 'segmentation', 'grounding')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  attempt_key text not null unique,
  input_tokens int check (input_tokens is null or input_tokens >= 0),
  output_tokens int check (output_tokens is null or output_tokens >= 0),
  reserved_cost_usd numeric(10,4) not null default 0 check (reserved_cost_usd >= 0),
  cost_usd numeric(10,4) check (cost_usd is null or cost_usd >= 0),
  error text,
  provider_file_name text,
  provider_deleted_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (survey_id, id),
  foreign key (survey_id, media_id)
    references public.cubic_survey_media(survey_id, id) on delete set null (media_id)
);

create table public.cubic_ai_detections (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  room_id uuid,
  segment_id uuid,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  catalogue_key text,
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  qty int not null default 1 check (qty between 1 and 999),
  confidence numeric(3,2) not null default 0 check (confidence between 0 and 1),
  moving text not null default 'moving' check (moving in ('moving', 'staying', 'uncertain')),
  flags jsonb not null default '{}'::jsonb check (jsonb_typeof(flags) = 'object'),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  review_reason text,
  state text not null default 'proposed'
    check (state in ('proposed', 'accepted', 'edited', 'rejected', 'merged')),
  resolution jsonb check (resolution is null or jsonb_typeof(resolution) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (survey_id, run_id)
    references public.cubic_analysis_runs(survey_id, id) on delete cascade,
  foreign key (survey_id, room_id)
    references public.cubic_survey_rooms(survey_id, id) on delete set null (room_id),
  foreign key (survey_id, segment_id)
    references public.cubic_survey_segments(survey_id, id) on delete set null (segment_id)
);

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('process_media', 'reconcile_survey')),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  media_id uuid,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'blocked', 'done', 'failed', 'dead', 'cancelled')),
  idempotency_key text not null unique,
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 4 check (max_attempts between 1 and 10),
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (survey_id, id),
  foreign key (survey_id, media_id)
    references public.cubic_survey_media(survey_id, id) on delete cascade,
  check (
    (kind = 'process_media' and media_id is not null)
    or (kind = 'reconcile_survey' and media_id is null)
  )
);

create table public.ai_spend_months (
  month date primary key check (month = date_trunc('month', month)::date),
  reserved_usd numeric(12,4) not null default 0 check (reserved_usd >= 0),
  spent_usd numeric(12,4) not null default 0 check (spent_usd >= 0),
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.cubic_surveys(id) on delete cascade,
  job_id uuid not null,
  attempt_key text not null unique,
  month date not null references public.ai_spend_months(month),
  estimated_usd numeric(10,4) not null check (estimated_usd > 0),
  actual_usd numeric(10,4) check (actual_usd is null or actual_usd >= 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'finalised', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalised_at timestamptz,
  foreign key (survey_id, job_id)
    references public.ai_jobs(survey_id, id) on delete cascade
);

create index cubic_survey_rooms_survey_sort_idx
  on public.cubic_survey_rooms(survey_id, sort);
create index cubic_survey_media_survey_idx
  on public.cubic_survey_media(survey_id);
create index cubic_survey_media_room_idx
  on public.cubic_survey_media(room_id);
create index cubic_survey_segments_survey_status_idx
  on public.cubic_survey_segments(survey_id, status);
create index cubic_survey_segments_media_idx
  on public.cubic_survey_segments(media_id);
create index cubic_analysis_runs_survey_idx
  on public.cubic_analysis_runs(survey_id, started_at desc);
create index cubic_analysis_runs_media_idx
  on public.cubic_analysis_runs(media_id);
create index cubic_ai_detections_survey_state_idx
  on public.cubic_ai_detections(survey_id, state);
create index cubic_ai_detections_room_idx
  on public.cubic_ai_detections(room_id);
create index cubic_ai_detections_run_idx
  on public.cubic_ai_detections(run_id);
create index cubic_ai_detections_segment_idx
  on public.cubic_ai_detections(segment_id);
create index ai_jobs_due_idx
  on public.ai_jobs(status, next_run_at);
create index ai_jobs_survey_idx
  on public.ai_jobs(survey_id);
create index ai_jobs_media_idx
  on public.ai_jobs(media_id);
create index ai_spend_reservations_survey_status_idx
  on public.ai_spend_reservations(survey_id, status);
create index ai_spend_reservations_job_idx
  on public.ai_spend_reservations(job_id);
create index ai_spend_reservations_month_idx
  on public.ai_spend_reservations(month, status);

create trigger trg_cubic_survey_rooms_updated
  before update on public.cubic_survey_rooms
  for each row execute function public.set_updated_at();
create trigger trg_cubic_survey_media_updated
  before update on public.cubic_survey_media
  for each row execute function public.set_updated_at();
create trigger trg_cubic_survey_segments_updated
  before update on public.cubic_survey_segments
  for each row execute function public.set_updated_at();
create trigger trg_cubic_ai_detections_updated
  before update on public.cubic_ai_detections
  for each row execute function public.set_updated_at();
create trigger trg_ai_jobs_updated
  before update on public.ai_jobs
  for each row execute function public.set_updated_at();
create trigger trg_ai_spend_months_updated
  before update on public.ai_spend_months
  for each row execute function public.set_updated_at();
create trigger trg_ai_spend_reservations_updated
  before update on public.ai_spend_reservations
  for each row execute function public.set_updated_at();

-- Authenticated office users can inspect AI state. They cannot directly mutate
-- tables, even if a browser session is compromised; service_role performs all
-- writes after server-side validation.
do $ai_rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cubic_survey_rooms',
    'cubic_survey_media',
    'cubic_survey_segments',
    'cubic_analysis_runs',
    'cubic_ai_detections',
    'ai_jobs',
    'ai_spend_months',
    'ai_spend_reservations'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for select using (public.is_office())',
      table_name || '_office_read',
      table_name
    );
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
  end loop;
end
$ai_rls$;

-- ---------------------------------------------------------------------------
-- Retention anchors

create or replace function public.sync_ai_retention_anchor_from_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status not in ('completed', 'declined')
     and new.status in ('completed', 'declined') then
    update public.cubic_surveys
    set media_retention_anchor_at = pg_catalog.now()
    where lead_id = new.id;
  elsif old.status in ('completed', 'declined')
        and new.status not in ('completed', 'declined') then
    update public.cubic_surveys
    set media_retention_anchor_at = null
    where lead_id = new.id;
  end if;
  return new;
end
$function$;

create trigger trg_leads_ai_retention_anchor
  after update of status on public.leads
  for each row
  when (old.status is distinct from new.status)
  execute function public.sync_ai_retention_anchor_from_lead();

create or replace function public.initialise_ai_retention_anchor_on_survey()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lead_is_terminal boolean := false;
begin
  if new.lead_id is not null then
    select lead.status in ('completed', 'declined')
    into lead_is_terminal
    from public.leads as lead
    where lead.id = new.lead_id;
  end if;

  if lead_is_terminal then
    new.media_retention_anchor_at := coalesce(new.media_retention_anchor_at, pg_catalog.now());
  elsif tg_op = 'INSERT' or old.lead_id is distinct from new.lead_id then
    new.media_retention_anchor_at := null;
  end if;
  return new;
end
$function$;

create trigger trg_cubic_surveys_ai_retention_anchor
  before insert or update of lead_id on public.cubic_surveys
  for each row execute function public.initialise_ai_retention_anchor_on_survey();

update public.cubic_surveys as survey
set media_retention_anchor_at = coalesce(survey.media_retention_anchor_at, pg_catalog.now())
from public.leads as lead
where lead.id = survey.lead_id
  and lead.status in ('completed', 'declined')
  and survey.media_retention_anchor_at is null;

-- Trigger functions are not API endpoints.
revoke all on function public.sync_ai_retention_anchor_from_lead() from public, anon, authenticated;
revoke all on function public.initialise_ai_retention_anchor_on_survey() from public, anon, authenticated;
grant execute on function public.sync_ai_retention_anchor_from_lead() to service_role;
grant execute on function public.initialise_ai_retention_anchor_on_survey() to service_role;

-- ---------------------------------------------------------------------------
-- Atomic finalise + enqueue

create or replace function public.finalize_ai_media(
  p_media_id uuid,
  p_actor_id uuid,
  p_bytes bigint,
  p_duration_s numeric,
  p_frames jsonb,
  p_prompt_version text
)
returns public.ai_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  media public.cubic_survey_media%rowtype;
  survey public.cubic_surveys%rowtype;
  job public.ai_jobs%rowtype;
  total_bytes numeric;
  total_duration numeric;
  video_count int;
  job_key text;
begin
  if p_bytes is null or p_bytes < 1 or p_bytes > 524288000 then
    raise exception 'invalid media byte count' using errcode = '22023';
  end if;
  if p_duration_s is not null and (p_duration_s < 0 or p_duration_s > 1200) then
    raise exception 'invalid media duration' using errcode = '22023';
  end if;
  if jsonb_typeof(p_frames) <> 'array' then
    raise exception 'frames must be an array' using errcode = '22023';
  end if;
  if p_prompt_version is null or char_length(p_prompt_version) not between 1 and 80 then
    raise exception 'invalid prompt version' using errcode = '22023';
  end if;

  select * into media
  from public.cubic_survey_media
  where id = p_media_id
  for update;
  if not found then
    raise exception 'media not found' using errcode = 'P0002';
  end if;

  job_key := 'process_media:' || media.id::text || ':' || p_prompt_version;
  if media.status in ('uploaded', 'processing', 'processed') then
    select * into job
    from public.ai_jobs
    where idempotency_key = job_key;
    if found then return job; end if;
  end if;
  if media.status <> 'uploading' then
    raise exception 'media cannot be finalised from status %', media.status using errcode = '55000';
  end if;
  if media.created_by is distinct from p_actor_id then
    raise exception 'media uploader mismatch' using errcode = '42501';
  end if;

  select * into survey
  from public.cubic_surveys
  where id = media.survey_id
  for update;
  if survey.ai_consent_withdrawn_at is not null
     or survey.ai_status = 'abandoned' then
    raise exception 'AI processing is no longer permitted' using errcode = '42501';
  end if;

  select
    coalesce(sum(coalesce(existing.bytes, 0)), 0) + p_bytes,
    coalesce(sum(coalesce(existing.duration_s, 0)), 0) + coalesce(p_duration_s, 0),
    count(*) filter (where existing.kind in ('room_video', 'import_video'))
      + case when media.kind in ('room_video', 'import_video') then 1 else 0 end
  into total_bytes, total_duration, video_count
  from public.cubic_survey_media as existing
  where existing.survey_id = media.survey_id
    and existing.id <> media.id
    and existing.status not in ('ignored', 'deleted');

  if total_bytes > 2147483648 then
    raise exception 'survey source media exceeds 2 GB' using errcode = '54000';
  end if;
  if total_duration > 1200 then
    raise exception 'survey video exceeds 20 minutes' using errcode = '54000';
  end if;
  if video_count > 20 then
    raise exception 'survey exceeds 20 videos' using errcode = '54000';
  end if;

  update public.cubic_survey_media
  set bytes = p_bytes,
      duration_s = p_duration_s,
      frames = p_frames,
      status = 'uploaded',
      finalized_at = pg_catalog.now(),
      error = null
  where id = media.id;

  insert into public.ai_jobs(kind, survey_id, media_id, idempotency_key)
  values ('process_media', media.survey_id, media.id, job_key)
  on conflict (idempotency_key) do nothing
  returning * into job;

  if job.id is null then
    select * into job from public.ai_jobs where idempotency_key = job_key;
  end if;

  update public.cubic_surveys
  set ai_status = 'active',
      planning_ready = false,
      room_manifest_complete = false,
      last_ai_user_activity_at = pg_catalog.now(),
      updated_by = p_actor_id
  where id = media.survey_id;

  if media.room_id is not null then
    update public.cubic_survey_rooms
    set status = 'processing'
    where id = media.room_id and status <> 'confirmed';
  end if;

  insert into public.activities(client_id, lead_id, actor_id, type, summary, meta)
  select survey.client_id, survey.lead_id, p_actor_id, 'note',
    'AI survey media uploaded', jsonb_build_object('mediaId', media.id)
  where survey.lead_id is not null or survey.client_id is not null;

  return job;
end
$function$;

-- ---------------------------------------------------------------------------
-- Queue leasing and room-state aggregation

create or replace function public.claim_ai_jobs(
  p_worker text,
  p_batch int default 1,
  p_lease_seconds int default 300
)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  exhausted record;
  exhausted_room_id uuid;
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'worker id is required' using errcode = '22023';
  end if;

  -- A disabled AI feature parks the queue without mutating jobs.
  if not exists (
    select 1
    from public.business_settings as settings
    where settings.id = true and settings.ai_survey_enabled = true
  ) then
    return;
  end if;

  -- A worker can disappear during its final permitted attempt. Reap those
  -- leases before claiming more work so they cannot remain running forever.
  for exhausted in
    update public.ai_jobs
    set status = 'dead',
        locked_at = null,
        locked_by = null,
        lease_expires_at = null,
        heartbeat_at = null,
        error = coalesce(error, 'Worker lease expired at maximum attempts')
    where status = 'running'
      and lease_expires_at < pg_catalog.now()
      and attempts >= max_attempts
    returning media_id
  loop
    if exhausted.media_id is not null then
      update public.cubic_survey_media
      set status = 'failed',
          error = 'AI processing exhausted all attempts'
      where id = exhausted.media_id
      returning room_id into exhausted_room_id;
      if exhausted_room_id is not null then
        perform public.recompute_ai_room_state(exhausted_room_id);
      end if;
    end if;
  end loop;

  return query
  update public.ai_jobs as job
  set status = 'running',
      attempts = case when job.status = 'blocked' then job.attempts else job.attempts + 1 end,
      locked_at = pg_catalog.now(),
      locked_by = p_worker,
      lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 30), 900)),
      heartbeat_at = pg_catalog.now(),
      error = null
  where job.id in (
    select candidate.id
    from public.ai_jobs as candidate
    where (
        (candidate.status in ('queued', 'blocked') and candidate.next_run_at <= pg_catalog.now())
        or (candidate.status = 'running' and candidate.lease_expires_at < pg_catalog.now())
      )
      and candidate.attempts < candidate.max_attempts
    order by candidate.created_at
    limit least(greatest(p_batch, 1), 5)
    for update skip locked
  )
  returning job.*;
end;
$function$;

create or replace function public.heartbeat_ai_job(
  p_job_id uuid,
  p_worker text,
  p_lease_seconds int default 300
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  with updated as (
    update public.ai_jobs
    set heartbeat_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 30), 900))
    where id = p_job_id
      and status = 'running'
      and locked_by = p_worker
      and lease_expires_at >= pg_catalog.now()
    returning id
  )
  select exists(select 1 from updated);
$function$;

create or replace function public.recompute_ai_room_state(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  active_count int;
  processed_count int;
  failed_count int;
  non_ignored_count int;
  aggregate_coverage text;
  aggregate_flags jsonb;
begin
  select
    count(*) filter (where status in ('uploading', 'uploaded', 'processing')),
    count(*) filter (where status = 'processed'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status not in ('ignored', 'deleted'))
  into active_count, processed_count, failed_count, non_ignored_count
  from public.cubic_survey_media
  where room_id = p_room_id;

  select
    case max(case media.coverage when 'poor' then 3 when 'partial' then 2 when 'good' then 1 else 0 end)
      when 3 then 'poor'
      when 2 then 'partial'
      when 1 then 'good'
      else null
    end,
    coalesce(jsonb_agg(distinct flag.value) filter (where flag.value is not null), '[]'::jsonb)
  into aggregate_coverage, aggregate_flags
  from public.cubic_survey_media as media
  left join lateral jsonb_array_elements(media.quality_flags) as flag(value)
    on media.status = 'processed'
  where media.room_id = p_room_id
    and media.status not in ('ignored', 'deleted');

  update public.cubic_survey_rooms
  set status = case
        when status = 'confirmed' then status
        when active_count > 0 then 'processing'
        when processed_count > 0 and failed_count > 0 then 'needs_attention'
        when processed_count > 0 and processed_count = non_ignored_count then 'ready'
        when processed_count = 0 and non_ignored_count > 0 then 'failed'
        else 'pending'
      end,
      coverage = aggregate_coverage,
      quality_flags = aggregate_flags
  where id = p_room_id;
end
$function$;

create or replace function public.fail_ai_job(
  p_job_id uuid,
  p_worker text,
  p_error text
)
returns public.ai_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.ai_jobs%rowtype;
  new_status text;
  room_id uuid;
begin
  select * into job
  from public.ai_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'job not found' using errcode = 'P0002';
  end if;
  if job.status in ('dead', 'done', 'cancelled') then return job; end if;
  if job.status <> 'running' or job.locked_by is distinct from p_worker then
    raise exception 'worker does not own job lease' using errcode = '40001';
  end if;

  new_status := case when job.attempts >= job.max_attempts then 'dead' else 'queued' end;
  update public.ai_jobs
  set status = new_status,
      next_run_at = case
        when new_status = 'queued' then pg_catalog.now()
          + pg_catalog.make_interval(secs => (30 * power(4, greatest(job.attempts - 1, 0)))::int)
        else next_run_at
      end,
      locked_at = null,
      locked_by = null,
      lease_expires_at = null,
      heartbeat_at = null,
      error = left(coalesce(p_error, 'AI processing failed'), 2000)
  where id = job.id
  returning * into job;

  if job.media_id is not null then
    select media.room_id into room_id
    from public.cubic_survey_media as media
    where media.id = job.media_id;
    update public.cubic_survey_media
    set status = case when new_status = 'dead' then 'failed' else 'processing' end,
        error = left(coalesce(p_error, 'AI processing failed'), 2000)
    where id = job.media_id;
    if room_id is not null then perform public.recompute_ai_room_state(room_id); end if;
  end if;
  return job;
end
$function$;

-- ---------------------------------------------------------------------------
-- Atomic spend reservations (USD_PER_GBP = 1.40 circuit-breaker conversion)

create or replace function public.reserve_ai_call(
  p_survey_id uuid,
  p_job_id uuid,
  p_attempt_key text,
  p_estimated_usd numeric
)
returns table(allowed boolean, reason text, reservation_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  ledger_month date := date_trunc('month', current_date)::date;
  month_row public.ai_spend_months%rowtype;
  existing public.ai_spend_reservations%rowtype;
  settings public.business_settings%rowtype;
  survey_total numeric;
  created_id uuid;
begin
  if p_estimated_usd is null or p_estimated_usd <= 0 then
    raise exception 'estimated cost must be positive' using errcode = '22023';
  end if;
  if p_attempt_key is null or char_length(p_attempt_key) not between 1 and 200 then
    raise exception 'invalid attempt key' using errcode = '22023';
  end if;

  perform 1 from public.cubic_surveys where id = p_survey_id for update;
  if not found then raise exception 'survey not found' using errcode = 'P0002'; end if;
  perform 1 from public.ai_jobs where id = p_job_id and survey_id = p_survey_id;
  if not found then raise exception 'job does not belong to survey' using errcode = '23503'; end if;

  select * into existing
  from public.ai_spend_reservations
  where attempt_key = p_attempt_key;
  if found then
    if existing.status = 'released' then
      return query select false, 'attempt_released', null::uuid;
    else
      return query select true, 'existing', existing.id;
    end if;
    return;
  end if;

  insert into public.ai_spend_months(month)
  values (ledger_month)
  on conflict (month) do nothing;
  select * into month_row
  from public.ai_spend_months
  where month = ledger_month
  for update;

  select * into settings
  from public.business_settings
  where id = true;
  if not found then raise exception 'business settings missing' using errcode = 'P0002'; end if;

  select coalesce(sum(
    case reservation.status
      when 'reserved' then reservation.estimated_usd
      when 'finalised' then coalesce(reservation.actual_usd, 0)
      else 0
    end
  ), 0)
  into survey_total
  from public.ai_spend_reservations as reservation
  where reservation.survey_id = p_survey_id;

  if survey_total + p_estimated_usd > settings.ai_survey_cap_gbp * 1.40 then
    return query select false, 'survey_cap', null::uuid;
    return;
  end if;
  if month_row.spent_usd + month_row.reserved_usd + p_estimated_usd
       > settings.ai_monthly_cap_gbp * 1.40 then
    return query select false, 'monthly_cap', null::uuid;
    return;
  end if;

  insert into public.ai_spend_reservations(
    survey_id, job_id, attempt_key, month, estimated_usd
  ) values (
    p_survey_id, p_job_id, p_attempt_key, ledger_month, p_estimated_usd
  )
  returning id into created_id;

  update public.ai_spend_months
  set reserved_usd = reserved_usd + p_estimated_usd
  where month = ledger_month;

  return query select true, null::text, created_id;
end
$function$;

create or replace function public.finalise_ai_call(
  p_attempt_key text,
  p_actual_usd numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.ai_spend_reservations%rowtype;
begin
  if p_actual_usd is null or p_actual_usd < 0 then
    raise exception 'actual cost cannot be negative' using errcode = '22023';
  end if;
  select * into reservation
  from public.ai_spend_reservations
  where attempt_key = p_attempt_key
  for update;
  if not found then raise exception 'reservation not found' using errcode = 'P0002'; end if;
  if reservation.status = 'finalised' then return true; end if;
  if reservation.status = 'released' then return false; end if;

  perform 1 from public.ai_spend_months where month = reservation.month for update;
  update public.ai_spend_months
  set reserved_usd = greatest(0, reserved_usd - reservation.estimated_usd),
      spent_usd = spent_usd + p_actual_usd
  where month = reservation.month;
  update public.ai_spend_reservations
  set status = 'finalised',
      actual_usd = p_actual_usd,
      finalised_at = pg_catalog.now()
  where id = reservation.id;
  return true;
end
$function$;

create or replace function public.release_ai_call(p_attempt_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.ai_spend_reservations%rowtype;
begin
  select * into reservation
  from public.ai_spend_reservations
  where attempt_key = p_attempt_key
  for update;
  if not found then return false; end if;
  if reservation.status = 'released' then return true; end if;
  if reservation.status = 'finalised' then return false; end if;

  perform 1 from public.ai_spend_months where month = reservation.month for update;
  update public.ai_spend_months
  set reserved_usd = greatest(0, reserved_usd - reservation.estimated_usd)
  where month = reservation.month;
  update public.ai_spend_reservations
  set status = 'released',
      finalised_at = pg_catalog.now()
  where id = reservation.id;
  return true;
end
$function$;

create or replace function public.release_stale_ai_reservations(p_age_minutes int default 30)
returns int
language plpgsql
security definer
set search_path = ''
as $function$
declare
  released_count int := 0;
  stale record;
begin
  for stale in
    select reservation.id, reservation.month, reservation.estimated_usd
    from public.ai_spend_reservations as reservation
    join public.ai_jobs as job on job.id = reservation.job_id
    where reservation.status = 'reserved'
      and reservation.created_at < pg_catalog.now() - pg_catalog.make_interval(mins => least(greatest(p_age_minutes, 5), 1440))
      and (job.status <> 'running' or job.lease_expires_at < pg_catalog.now())
    for update of reservation skip locked
  loop
    perform 1 from public.ai_spend_months where month = stale.month for update;
    update public.ai_spend_months
    set reserved_usd = greatest(0, reserved_usd - stale.estimated_usd)
    where month = stale.month;
    update public.ai_spend_reservations
    set status = 'released', finalised_at = pg_catalog.now()
    where id = stale.id;
    released_count := released_count + 1;
  end loop;
  return released_count;
end
$function$;

-- ---------------------------------------------------------------------------
-- Transactional worker completion

create or replace function public.complete_ai_media_job(
  p_job_id uuid,
  p_worker text,
  p_run_id uuid,
  p_detections jsonb,
  p_coverage text,
  p_quality_flags jsonb,
  p_quality_warnings jsonb,
  p_input_tokens int,
  p_output_tokens int,
  p_actual_usd numeric,
  p_provider_deleted boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.ai_jobs%rowtype;
  media public.cubic_survey_media%rowtype;
  survey public.cubic_surveys%rowtype;
  run public.cubic_analysis_runs%rowtype;
begin
  if jsonb_typeof(p_detections) <> 'array'
     or jsonb_typeof(p_quality_flags) <> 'array'
     or jsonb_typeof(p_quality_warnings) <> 'array'
     or p_coverage not in ('good', 'partial', 'poor') then
    raise exception 'invalid completion payload' using errcode = '22023';
  end if;

  select * into job from public.ai_jobs where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if job.status = 'done' then return true; end if;
  if job.status <> 'running' or job.locked_by is distinct from p_worker then
    raise exception 'worker does not own job lease' using errcode = '40001';
  end if;
  if job.lease_expires_at < pg_catalog.now() then
    raise exception 'worker lease expired' using errcode = '40001';
  end if;

  select * into media from public.cubic_survey_media where id = job.media_id for update;
  select * into survey from public.cubic_surveys where id = job.survey_id for update;
  select * into run from public.cubic_analysis_runs
  where id = p_run_id and survey_id = job.survey_id and media_id = job.media_id
  for update;
  if not found then raise exception 'analysis run does not belong to job media' using errcode = '23503'; end if;
  if run.status = 'succeeded' then return true; end if;
  if run.status <> 'running' then
    raise exception 'analysis run is not active' using errcode = '55000';
  end if;

  perform public.finalise_ai_call(run.attempt_key, p_actual_usd);

  if survey.ai_consent_withdrawn_at is not null
     or survey.ai_status = 'abandoned' then
    update public.cubic_analysis_runs
    set status = 'failed',
        input_tokens = greatest(coalesce(p_input_tokens, 0), 0),
        output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
        cost_usd = p_actual_usd,
        error = 'discarded-after-consent-withdrawal',
        provider_deleted_at = case when p_provider_deleted then pg_catalog.now() else provider_deleted_at end,
        finished_at = pg_catalog.now()
    where id = run.id;
    update public.cubic_survey_media
    set status = 'deletion_pending', error = 'Customer withdrew agreement'
    where id = media.id;
    update public.ai_jobs
    set status = 'cancelled',
        locked_at = null,
        locked_by = null,
        lease_expires_at = null,
        heartbeat_at = null,
        payload = payload || jsonb_build_object('providerDeleted', p_provider_deleted)
    where id = job.id;
    if media.room_id is not null then perform public.recompute_ai_room_state(media.room_id); end if;
    return false;
  end if;

  insert into public.cubic_ai_detections(
    run_id, survey_id, room_id, segment_id, label, catalogue_key,
    candidates, qty, confidence, moving, flags, evidence, review_reason
  )
  select
    run.id,
    job.survey_id,
    nullif(detection.value ->> 'roomId', '')::uuid,
    nullif(detection.value ->> 'segmentId', '')::uuid,
    detection.value ->> 'label',
    nullif(detection.value ->> 'catalogueKey', ''),
    coalesce(detection.value -> 'candidates', '[]'::jsonb),
    coalesce((detection.value ->> 'qty')::int, 1),
    coalesce((detection.value ->> 'confidence')::numeric, 0),
    coalesce(detection.value ->> 'moving', 'moving'),
    coalesce(detection.value -> 'flags', '{}'::jsonb),
    coalesce(detection.value -> 'evidence', '{}'::jsonb),
    nullif(detection.value ->> 'reviewReason', '')
  from jsonb_array_elements(p_detections) as detection(value);

  update public.cubic_analysis_runs
  set status = 'succeeded',
      input_tokens = greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
      cost_usd = p_actual_usd,
      provider_deleted_at = case when p_provider_deleted then pg_catalog.now() else provider_deleted_at end,
      finished_at = pg_catalog.now()
  where id = run.id;
  update public.cubic_survey_media
  set status = 'processed',
      coverage = p_coverage,
      quality_flags = p_quality_flags,
      error = null
  where id = media.id;
  update public.ai_jobs
  set status = 'done',
      locked_at = null,
      locked_by = null,
      lease_expires_at = null,
      heartbeat_at = null,
      error = null,
      payload = payload || jsonb_build_object('providerDeleted', p_provider_deleted)
  where id = job.id;

  if media.room_id is not null then
    update public.cubic_survey_rooms
    set quality_warnings = p_quality_warnings
    where id = media.room_id;
    perform public.recompute_ai_room_state(media.room_id);
  end if;
  return true;
end
$function$;

-- ---------------------------------------------------------------------------
-- Atomic confirmed-room merge into canonical inventory

create or replace function public.confirm_ai_room(
  p_survey_id uuid,
  p_room_id uuid,
  p_base_updated_at timestamptz,
  p_new_lines jsonb,
  p_detection_ids uuid[],
  p_total_ft3 numeric,
  p_contingency_pct int,
  p_planning_ready boolean,
  p_actor_id uuid
)
returns public.cubic_surveys
language plpgsql
security definer
set search_path = ''
as $function$
declare
  survey public.cubic_surveys%rowtype;
  room public.cubic_survey_rooms%rowtype;
  detection_count int;
  result public.cubic_surveys%rowtype;
begin
  if jsonb_typeof(p_new_lines) <> 'array'
     or p_total_ft3 < 0
     or p_contingency_pct not in (0, 10, 20, 30) then
    raise exception 'invalid confirmation payload' using errcode = '22023';
  end if;

  select * into survey
  from public.cubic_surveys
  where id = p_survey_id
  for update;
  if not found then raise exception 'survey not found' using errcode = 'P0002'; end if;

  select * into room
  from public.cubic_survey_rooms
  where id = p_room_id and survey_id = p_survey_id
  for update;
  if not found then raise exception 'room not found' using errcode = 'P0002'; end if;

  -- A lost response may retry the exact confirmation. Once all supplied
  -- detections are merged, return the current row without appending lines.
  if room.status = 'confirmed'
     and not exists (
       select 1 from public.cubic_ai_detections
       where id = any(coalesce(p_detection_ids, '{}'::uuid[])) and state <> 'merged'
     ) then
    return survey;
  end if;
  if survey.updated_at is distinct from p_base_updated_at then
    raise exception 'cubic survey changed in another session' using errcode = '40001';
  end if;

  select count(*) into detection_count
  from public.cubic_ai_detections
  where id = any(coalesce(p_detection_ids, '{}'::uuid[]))
    and survey_id = p_survey_id
    and room_id = p_room_id
    and state in ('accepted', 'edited');
  if detection_count <> coalesce(array_length(p_detection_ids, 1), 0) then
    raise exception 'detections are not confirmable for this room' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_new_lines) as line(value)
    where jsonb_typeof(line.value) <> 'object'
       or jsonb_typeof(line.value -> 'id') <> 'string'
       or (line.value ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or line.value ->> 'source' <> 'ai'
       or line.value ->> 'room' <> room.name
       or jsonb_typeof(line.value -> 'aiDetectionIds') <> 'array'
  ) then
    raise exception 'canonical AI lines are malformed' using errcode = '23514';
  end if;

  update public.cubic_surveys
  set items = items || p_new_lines,
      total_ft3 = p_total_ft3,
      contingency_pct = p_contingency_pct,
      planning_ready = p_planning_ready,
      ai_status = case when p_planning_ready then 'complete' else 'active' end,
      last_ai_user_activity_at = pg_catalog.now(),
      updated_by = p_actor_id
  where id = survey.id;
  update public.cubic_ai_detections
  set state = 'merged'
  where id = any(coalesce(p_detection_ids, '{}'::uuid[]));
  update public.cubic_survey_rooms
  set status = 'confirmed', completion_method = 'ai'
  where id = room.id;

  insert into public.activities(client_id, lead_id, actor_id, type, summary, meta)
  select survey.client_id, survey.lead_id, p_actor_id, 'note',
    'AI room confirmed', jsonb_build_object('roomId', room.id, 'room', room.name)
  where survey.lead_id is not null or survey.client_id is not null;

  select * into result from public.cubic_surveys where id = survey.id;
  return result;
end
$function$;

-- New routines inherit broad grants from migration 0001 and PostgreSQL grants
-- EXECUTE to PUBLIC by default. Remove both, then expose only to service_role.
revoke all on function public.finalize_ai_media(uuid, uuid, bigint, numeric, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.claim_ai_jobs(text, int, int)
  from public, anon, authenticated;
revoke all on function public.heartbeat_ai_job(uuid, text, int)
  from public, anon, authenticated;
revoke all on function public.recompute_ai_room_state(uuid)
  from public, anon, authenticated;
revoke all on function public.fail_ai_job(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.reserve_ai_call(uuid, uuid, text, numeric)
  from public, anon, authenticated;
revoke all on function public.finalise_ai_call(text, numeric)
  from public, anon, authenticated;
revoke all on function public.release_ai_call(text)
  from public, anon, authenticated;
revoke all on function public.release_stale_ai_reservations(int)
  from public, anon, authenticated;
revoke all on function public.complete_ai_media_job(
  uuid, text, uuid, jsonb, text, jsonb, jsonb, int, int, numeric, boolean
) from public, anon, authenticated;
revoke all on function public.confirm_ai_room(
  uuid, uuid, timestamptz, jsonb, uuid[], numeric, int, boolean, uuid
) from public, anon, authenticated;

grant execute on function public.finalize_ai_media(uuid, uuid, bigint, numeric, jsonb, text)
  to service_role;
grant execute on function public.claim_ai_jobs(text, int, int)
  to service_role;
grant execute on function public.heartbeat_ai_job(uuid, text, int)
  to service_role;
grant execute on function public.recompute_ai_room_state(uuid)
  to service_role;
grant execute on function public.fail_ai_job(uuid, text, text)
  to service_role;
grant execute on function public.reserve_ai_call(uuid, uuid, text, numeric)
  to service_role;
grant execute on function public.finalise_ai_call(text, numeric)
  to service_role;
grant execute on function public.release_ai_call(text)
  to service_role;
grant execute on function public.release_stale_ai_reservations(int)
  to service_role;
grant execute on function public.complete_ai_media_job(
  uuid, text, uuid, jsonb, text, jsonb, jsonb, int, int, numeric, boolean
) to service_role;
grant execute on function public.confirm_ai_room(
  uuid, uuid, timestamptz, jsonb, uuid[], numeric, int, boolean, uuid
) to service_role;
