begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select has_table('public', 'cubic_survey_rooms', 'rooms table exists');
select has_table('public', 'cubic_survey_media', 'media table exists');
select has_table('public', 'cubic_survey_segments', 'segments table exists');
select has_table('public', 'cubic_analysis_runs', 'analysis runs table exists');
select has_table('public', 'cubic_ai_detections', 'detections table exists');
select has_table('public', 'ai_jobs', 'jobs table exists');
select has_table('public', 'ai_spend_months', 'monthly spend table exists');
select has_table('public', 'ai_spend_reservations', 'spend reservations table exists');

select ok(
  not exists (
    select 1
    from pg_class
    where oid = any(array[
      'public.cubic_survey_rooms'::regclass,
      'public.cubic_survey_media'::regclass,
      'public.cubic_survey_segments'::regclass,
      'public.cubic_analysis_runs'::regclass,
      'public.cubic_ai_detections'::regclass,
      'public.ai_jobs'::regclass,
      'public.ai_spend_months'::regclass,
      'public.ai_spend_reservations'::regclass
    ]) and not relrowsecurity
  ),
  'RLS is enabled on every AI domain table'
);

select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name in (
        'cubic_survey_rooms', 'cubic_survey_media', 'cubic_survey_segments',
        'cubic_analysis_runs', 'cubic_ai_detections', 'ai_jobs',
        'ai_spend_months', 'ai_spend_reservations'
      )
      and privilege_type <> 'SELECT'
  ),
  0,
  'authenticated users have no AI table write grants'
);

select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where grantee = 'anon'
      and table_schema = 'public'
      and table_name in (
        'cubic_survey_rooms', 'cubic_survey_media', 'cubic_survey_segments',
        'cubic_analysis_runs', 'cubic_ai_detections', 'ai_jobs',
        'ai_spend_months', 'ai_spend_reservations'
      )
  ),
  0,
  'anonymous users have no AI table grants'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_ai_jobs(text,integer,integer)',
    'EXECUTE'
  ),
  'service role can execute the job claim RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_ai_jobs(text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot execute the job claim RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.claim_ai_jobs(text,integer,integer)',
    'EXECUTE'
  ),
  'anonymous users cannot execute the job claim RPC'
);

select is(
  (select count(*)::int from storage.buckets where id = 'survey-media' and not public),
  1,
  'provider migration creates one private AI media bucket'
);
select is(
  (
    select count(*)::int
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in ('survey_media_read', 'survey_media_insert', 'survey_media_update', 'survey_media_delete')
  ),
  4,
  'provider migration installs the four path-bound storage policies'
);

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values
  ('10000000-0000-4000-8000-000000000001', 'crew-ai-test@example.invalid', '{}'::jsonb, '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000002', 'estimator-ai-test@example.invalid', '{}'::jsonb, '{}'::jsonb);
update public.profiles
set role = 'crew', active = true
where id = '10000000-0000-4000-8000-000000000001';
update public.profiles
set role = 'estimator', active = true
where id = '10000000-0000-4000-8000-000000000002';

insert into public.cubic_surveys (id, created_by)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
insert into public.cubic_survey_rooms (id, survey_id, name, created_by)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'Kitchen',
    '10000000-0000-4000-8000-000000000002'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'Office',
    '10000000-0000-4000-8000-000000000002'
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(
  (select count(*)::int from public.cubic_survey_rooms),
  0,
  'crew cannot read AI rooms'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select is(
  (select count(*)::int from public.cubic_survey_rooms),
  2,
  'active estimator can read AI rooms'
);
reset role;

insert into public.cubic_survey_media (
  id, survey_id, room_id, kind, storage_path, mime, status, created_by
) values (
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'room_video',
  '20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/source.mp4',
  'video/mp4',
  'uploaded',
  '10000000-0000-4000-8000-000000000002'
);
insert into public.ai_jobs (
  id, kind, survey_id, media_id, idempotency_key
) values (
  '50000000-0000-4000-8000-000000000001',
  'process_media',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'test:process-media'
);

update public.cubic_survey_media set status = 'uploading'
where id = '40000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$insert into storage.objects(bucket_id, name, owner)
    values (
      'survey-media',
      '20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/source.mp4',
      '10000000-0000-4000-8000-000000000002'
    )$$,
  'estimator can insert the exact preregistered source path'
);
select lives_ok(
  $$insert into storage.objects(bucket_id, name, owner)
    values (
      'survey-media',
      '20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/frames/00010001.jpg',
      '10000000-0000-4000-8000-000000000002'
    )$$,
  'estimator can insert a valid evidence-frame path'
);
select lives_ok(
  $$update storage.objects set metadata = '{"mimetype":"video/mp4","size":42}'::jsonb
    where bucket_id = 'survey-media'
      and name = '20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/source.mp4'$$,
  'estimator can retry/upsert the exact preregistered source path'
);
reset role;
update public.cubic_survey_media set status = 'uploaded'
where id = '40000000-0000-4000-8000-000000000001';

update public.business_settings set ai_survey_enabled = false where id = true;
select is(
  (select count(*)::int from public.claim_ai_jobs('worker-test', 1, 300)),
  0,
  'disabled AI parks the queue without claiming'
);
select is(
  (select status from public.ai_jobs where id = '50000000-0000-4000-8000-000000000001'),
  'queued',
  'disabled AI leaves the queued job unchanged'
);

update public.business_settings set ai_survey_enabled = true where id = true;
select is(
  (select count(*)::int from public.claim_ai_jobs('worker-test', 1, 300)),
  1,
  'enabled AI claims one due job'
);
select is(
  (
    select status || ':' || attempts::text
    from public.ai_jobs
    where id = '50000000-0000-4000-8000-000000000001'
  ),
  'running:1',
  'claim records running state and attempt number'
);
select is(
  public.heartbeat_ai_job(
    '50000000-0000-4000-8000-000000000001',
    'wrong-worker',
    300
  ),
  false,
  'a different worker cannot renew the lease'
);
select is(
  (public.fail_ai_job(
    '50000000-0000-4000-8000-000000000001',
    'worker-test',
    'temporary failure'
  )).status,
  'queued',
  'owned failure requeues a retryable job'
);

update public.ai_jobs
set status = 'running',
    attempts = max_attempts,
    locked_by = 'lost-worker',
    locked_at = now() - interval '10 minutes',
    lease_expires_at = now() - interval '5 minutes'
where id = '50000000-0000-4000-8000-000000000001';
update public.cubic_survey_media
set status = 'processing'
where id = '40000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.claim_ai_jobs('reaper', 1, 300)),
  0,
  'expired final attempt is reaped instead of reclaimed'
);
select is(
  (select status from public.ai_jobs where id = '50000000-0000-4000-8000-000000000001'),
  'dead',
  'expired final-attempt job becomes dead'
);
select is(
  (select status from public.cubic_survey_media where id = '40000000-0000-4000-8000-000000000001'),
  'failed',
  'expired final-attempt media becomes failed'
);
select is(
  (select status from public.cubic_survey_rooms where id = '30000000-0000-4000-8000-000000000001'),
  'failed',
  'expired final attempt recomputes the room to failed'
);

select is(
  (select allowed from public.reserve_ai_call(
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'released-attempt', 0.10
  )), true, 'spend reservation is initially allowed'
);
select is(public.release_ai_call('released-attempt'), true, 'reservation can be released');
select is(
  (select allowed::text || ':' || reason from public.reserve_ai_call(
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'released-attempt', 0.10
  )), 'false:attempt_released', 'released attempt cannot silently bypass reservation'
);

select is(
  (select allowed from public.reserve_ai_call(
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'stale-attempt', 0.10
  )), true, 'stale-sweep fixture is reserved'
);
update public.ai_spend_reservations set created_at = now() - interval '2 hours' where attempt_key = 'stale-attempt';
select is(public.release_stale_ai_reservations(30), 1, 'stale reservation sweeper releases abandoned ledger rows');
select is((select status from public.ai_spend_reservations where attempt_key = 'stale-attempt'), 'released', 'stale reservation is marked released');

update public.ai_jobs set status = 'blocked', attempts = 2, next_run_at = now() - interval '1 minute', locked_by = null, lease_expires_at = null
where id = '50000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.claim_ai_jobs('unblocked-worker', 1, 300)), 1, 'due budget-blocked job is reconsidered');
select is((select status || ':' || attempts::text from public.ai_jobs where id = '50000000-0000-4000-8000-000000000001'), 'running:2', 'budget reconsideration does not consume a retry attempt');

select * from finish();
rollback;
