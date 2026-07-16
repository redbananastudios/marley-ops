-- Job content capture (docs/job-content-capture-prd.md v1.0, Peter 2026-07-16):
-- crew/estimators capture photos / video / voice notes on jobs; voice notes get
-- Gemini transcripts; the OFFICE approves items before any marketing use.
-- Media lives in the private job-media bucket at <lead_id>/<uuid>.<ext>.

create table public.job_media (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  kind text not null check (kind in ('photo','video','audio')),
  storage_path text not null unique,
  mime text,
  bytes bigint,
  duration_s int,
  caption text not null default '',
  tag text check (tag in ('before','after','access','team','story','other')),
  -- a voice note can narrate a photo/video (transcript becomes its context)
  attached_to uuid references public.job_media(id) on delete set null,
  -- stamped from leads.media_consent AT CAPTURE TIME; internal_only rows can
  -- never be marketing-approved (enforced in the action + belt below)
  consent_state text not null default 'unset'
    check (consent_state in ('unset','granted','internal_only')),
  transcript text,
  transcript_status text not null default 'none'
    check (transcript_status in ('none','pending','running','done','failed')),
  transcript_error text,
  transcript_attempts int not null default 0,
  captured_by uuid references public.profiles(id) on delete set null,
  captured_by_name text not null default '',
  marketing_approved_at timestamptz,
  marketing_approved_by uuid references public.profiles(id) on delete set null,
  -- publishing phase (Drive hub sync) stamps this; deliberately unused for now
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- DB belt for the consent invariant (the action is the braces)
  check (marketing_approved_at is null or consent_state <> 'internal_only')
);

create index job_media_lead_idx on public.job_media (lead_id, created_at desc);
create index job_media_transcribe_idx on public.job_media (transcript_status)
  where transcript_status in ('pending','failed');
create index job_media_unsynced_idx on public.job_media (marketing_approved_at)
  where marketing_approved_at is not null and synced_at is null;

create trigger trg_job_media_updated
  before update on public.job_media
  for each row execute function public.set_updated_at();

alter table public.job_media enable row level security;
create policy job_media_read   on public.job_media for select using (is_staff());
create policy job_media_insert on public.job_media for insert with check (is_staff());
create policy job_media_update on public.job_media for update using (is_office());
create policy job_media_delete on public.job_media for delete using (is_admin());

-- Private bucket (mirror of job-photos, 0028): staff capture + view, admin delete.
insert into storage.buckets (id, name, public) values ('job-media','job-media', false)
  on conflict (id) do nothing;
create policy job_media_obj_read   on storage.objects for select using (bucket_id = 'job-media' and is_staff());
create policy job_media_obj_write  on storage.objects for insert with check (bucket_id = 'job-media' and is_staff());
create policy job_media_obj_delete on storage.objects for delete using (bucket_id = 'job-media' and is_admin());

-- Per-job marketing consent (set by whoever asks the customer); captures stamp
-- the state they were born under.
alter table public.leads add column media_consent text not null default 'unset'
  check (media_consent in ('unset','granted','internal_only'));
