-- 0117: customer-uploaded survey photos get their own discriminator, the
-- per-survey ceiling moves out of the application and into the database, the
-- `surveys` row a /cv photo hangs off is resolved-or-created ATOMICALLY, and
-- "have we already told the office about this?" becomes a stored fact rather
-- than a count (findings B3 + B4, then C1 + C2, of the /cv photo review,
-- 2026-09-02).
--
-- Four problems, one migration, because each fix needs one of the others'
-- columns or locks:
--
-- (B4) `survey_photos` had no way to say "a customer sent this". The crew job
--      sheet reads a survey's photos `order by created_at asc limit cap*2` with
--      cap = 3, so it only ever sees the SIX OLDEST rows. The /cv link goes out
--      BEFORE the survey visit, so up to twenty customer photos are older than
--      every estimator photo — the crew's driveway/parking ACCESS shots would
--      stop reaching the sheet entirely and would never even be fetched.
--      `uploaded_by is null` is not a usable discriminator: it is nullable and
--      historic office rows may carry null, so filtering on it would hide real
--      estimator photos from the crew. Hence an explicit boolean.
--
-- (B3) the cap and the once-only timeline note were both check-then-act in the
--      route: an independent `select count(*)` followed by an unguarded insert.
--      N concurrent POSTs all read 0, all pass the cap and all insert — so the
--      stated bound did not hold, and the `if (existing === 0)` guard wrote one
--      duplicate "Customer added photos" activity per racing request, which is
--      exactly the amplification its own comment promised to prevent.
--
-- (C1) `ensureSurveyRowForCustomer` was check-then-act too, one level up: it
--      read the lead's newest `surveys` row and inserted one if it found none,
--      with no uniqueness behind it (`surveys_lead_idx` is a plain index, and
--      it cannot become unique — the office deliberately allows a lead to have
--      more than one survey over time). Two concurrent FIRST uploads — the same
--      customer opening their link on a phone and a laptop, or a slow request
--      they retry — therefore created two rows. EVERY downstream reader takes
--      only the lead's NEWEST survey (the /cv page, loadSurveyPhotos,
--      loadJobSheet, crew-sheet/daily-data, schedule/actions), so a photo
--      written against the loser is invisible to the customer and the office
--      forever, and does not count toward the ceiling B3 has just made real.
--      `ensure_customer_survey_row` below serialises find-or-create on a
--      transaction-scoped advisory lock keyed by the lead.
--
-- (C2) `is_first` was derived from a LIVE count (`v_before = 0`), and the
--      customer's own delete action hard-deletes rows. So a customer retaking
--      one blurry shot five times wrote five identical "Customer added photos
--      to their cubic survey" timeline rows, and a token holder could loop it
--      deliberately — which is the amplification the route's own comment
--      promises cannot happen. Whether the office has been told is now a fact
--      stored on the survey (`customer_photos_noted_at`), so it survives the
--      deletion of every photo that caused it, and it is read and written
--      inside the same locked window as the insert, so it is still race-free.
--
-- DELIBERATELY NO BACKFILL. Every existing row keeps `customer_uploaded =
-- false`, i.e. "an office photo", which is bit-for-bit today's behaviour on
-- every reader. Inferring the flag from `uploaded_by is null` would fail in the
-- expensive direction — a historic office ACCESS photo mis-stamped as a
-- customer photo silently vanishes from the crew day sheet, which is the very
-- failure this column exists to prevent. Any /cv rows created on STAGING before
-- this migration therefore read as office photos and drop out of the customer's
-- own gallery; that surface has never run in production, so the only cost is
-- re-uploading a test photo.

alter table public.survey_photos
  add column if not exists customer_uploaded boolean not null default false;

comment on column public.survey_photos.customer_uploaded is
  'True only for photos a customer attached through their own /cv/<token> link. The crew job sheet and /my-jobs exclude these (they would otherwise starve the estimator''s access shots off an asc+limit read); the office survey gallery shows them. Never inferred from uploaded_by — that column is nullable and historically null on office rows.';

-- The customer count guard below, and the customer gallery read, both filter on
-- (survey_id, customer_uploaded); the crew readers filter the complement and
-- order by created_at. A partial index over just the customer rows keeps the
-- guard's count cheap without adding write cost to the office path.
create index if not exists survey_photos_customer_idx
  on public.survey_photos (survey_id, created_at)
  where customer_uploaded;

-- (C2) "the office has been told about this survey's customer photos" as a
-- STORED FACT. Null on every existing row, which is correct rather than a
-- backfill gap: no survey has ever carried a customer photo, so the first one
-- to arrive genuinely is the first and genuinely is worth a timeline line.
alter table public.surveys
  add column if not exists customer_photos_noted_at timestamptz;

comment on column public.surveys.customer_photos_noted_at is
  'When the lead''s timeline was first told that a customer had attached photos through their own /cv link. Set once, inside add_customer_survey_photo''s locked window, and never cleared — deriving this from a live photo count instead let a customer who deletes and re-uploads write one duplicate timeline row per cycle.';

-- ============================================================
-- ensure_customer_survey_row — find-or-create the anchor row, atomically
-- ============================================================
--
-- `survey_photos.survey_id` points at `surveys`, not `cubic_surveys`, so the
-- /cv upload route needs the same lazily-created row the office's
-- `ensureSurveyForLead` creates — and must pick the SAME one, because every
-- reader on both sides takes the lead's NEWEST survey.
--
-- Serialisation is a TRANSACTION-SCOPED ADVISORY LOCK keyed on the lead, not a
-- `for update` on the `leads` row: locking the lead itself would block ordinary
-- lead edits (and could deadlock against them) over a concern they have nothing
-- to do with. A unique constraint is not available either — a lead legitimately
-- accumulates more than one survey over its life, which is exactly why every
-- reader orders by `created_at desc limit 1`.
--
-- SECURITY DEFINER for the same reason as the photo insert below: the /cv
-- surface has no session at all and reaches this through the service role. It
-- is not an escalation surface — the grants below leave it callable by
-- service_role only, it writes exactly one row shape, and the lead id it writes
-- against is re-derived server-side from the share token on every request.
create or replace function public.ensure_customer_survey_row(
  p_lead_id uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if p_lead_id is null then
    raise exception 'ensure_customer_survey_row requires a lead' using errcode = '22023';
  end if;

  -- Held until this function's implicit transaction ends, so a second caller
  -- for the SAME lead waits and then sees the first caller's committed row.
  -- Different leads hash to different keys and never queue behind each other.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('cv_survey_row:' || p_lead_id::text)::bigint
  );

  select s.id into v_id
    from public.surveys s
   where s.lead_id = p_lead_id
   order by s.created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- `status` is deliberately left to its column default ('scheduled'), which is
  -- what the application inserted explicitly — same row, one fewer enum literal
  -- to keep in step under `search_path = ''`.
  insert into public.surveys (lead_id, client_id)
  values (p_lead_id, p_client_id)
  returning id into v_id;

  return v_id;
end
$function$;

comment on function public.ensure_customer_survey_row(uuid, uuid) is
  'Find (or create) the surveys row a lead''s customer /cv photos hang off, atomically. Serialised per lead on a transaction-scoped advisory lock, because two concurrent first uploads would otherwise create two rows and every reader takes only the newest — stranding the loser''s photos where neither the customer nor the office can see them. Service role only.';

revoke all on function public.ensure_customer_survey_row(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_customer_survey_row(uuid, uuid) to service_role;

-- ============================================================
-- add_customer_survey_photo — the count-guarded insert, atomically
-- ============================================================
--
-- Serialisation is a `for update` row lock on the parent `surveys` row, NOT the
-- bare `insert ... select ... where (select count(*)) < n` shape. Under READ
-- COMMITTED that shape is *not* atomic: two concurrent transactions cannot see
-- each other's uncommitted insert, so both count 0 and both write. Taking the
-- parent row's lock first makes the second caller wait for the first to commit,
-- and only then count — which is what actually makes the ceiling hold. The lock
-- is per-survey and released when this function's implicit transaction ends, so
-- two different customers never queue behind each other.
--
-- `is_first` is decided inside the same locked window, so the caller's
-- once-only timeline note cannot race either: exactly one concurrent uploader
-- is told it went first. It is decided from `surveys.customer_photos_noted_at`
-- rather than from the count, because the count is not a record of what we have
-- already said — deleting every photo takes it back to 0, and the next upload
-- would write the same timeline row again (C2). The flag is stamped in the same
-- window it is read in, so it is exactly as race-free as the count was.
--
-- SECURITY DEFINER purely to own the write (the `survey_photos` RLS policies
-- from 0069 are office-only, and the /cv surface has no session at all — the
-- route reaches this through the service role). It is NOT a privilege
-- escalation surface: `revoke`/`grant` below leave it callable only by
-- service_role, it writes exactly one row shape, and the survey id it writes
-- against is re-derived server-side from the share token on every request.
create or replace function public.add_customer_survey_photo(
  p_survey_id uuid,
  p_storage_path text,
  p_max integer
)
returns table (photo_id uuid, capped boolean, is_first boolean, remaining integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_before integer;
  v_id uuid;
  v_locked uuid;
  v_noted timestamptz;
begin
  if p_survey_id is null or p_storage_path is null or p_max is null then
    raise exception 'add_customer_survey_photo requires a survey, a path and a ceiling'
      using errcode = '22023';
  end if;

  -- Serialise every customer upload for THIS survey behind the parent row, and
  -- read the once-only timeline marker under the same lock.
  select s.id, s.customer_photos_noted_at
    into v_locked, v_noted
    from public.surveys s
   where s.id = p_survey_id
   for update;
  if v_locked is null then
    -- The caller creates this row before uploading, so a miss means it vanished
    -- underneath us. Refuse loudly rather than returning a shape that reads as
    -- "saved" or as "capped".
    raise exception 'survey % not found', p_survey_id using errcode = 'P0002';
  end if;

  select count(*) into v_before
    from public.survey_photos sp
   where sp.survey_id = p_survey_id
     and sp.customer_uploaded;

  insert into public.survey_photos (survey_id, category, storage_path, uploaded_by, customer_uploaded)
  select p_survey_id, 'cubic'::public.photo_category, p_storage_path, null, true
   where v_before < p_max
  returning id into v_id;

  photo_id := v_id;
  capped := v_id is null;
  is_first := v_id is not null and v_noted is null;
  remaining := greatest(p_max - (v_before + (case when v_id is null then 0 else 1 end)), 0);

  -- Stamped inside the lock, so the second of two simultaneous uploads reads a
  -- non-null marker and is told it did not go first. Never cleared: this is the
  -- record that the office has been told, not a count of what currently exists.
  if is_first then
    update public.surveys
       set customer_photos_noted_at = pg_catalog.now()
     where id = p_survey_id;
  end if;

  return next;
end
$function$;

comment on function public.add_customer_survey_photo(uuid, text, integer) is
  'Insert one customer /cv survey photo under a per-survey ceiling, atomically. Locks the parent surveys row so concurrent uploads cannot both pass the count; also reports whether the office has yet been told about this survey''s customer photos (surveys.customer_photos_noted_at, stamped in the same locked window), so the caller''s timeline note is written exactly once and stays written after the photos are deleted. Service role only.';

revoke all on function public.add_customer_survey_photo(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.add_customer_survey_photo(uuid, text, integer) to service_role;

-- New column AND new function: PostgREST rejects a select naming a column its
-- cached schema has never seen, and rejects an rpc it has never seen — and the
-- crew photo readers fail SOFT (`const { data: rows } = await …`), so without
-- this the day sheet would come back silently photo-less rather than erroring.
notify pgrst, 'reload schema';
