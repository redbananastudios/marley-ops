# Job Content Capture — PRD v1.0 (implementation grade)

**Status: APPROVED TO BUILD (Peter, 2026-07-16).** Scope = CAPTURE side only:
crew/estimators capture photos, video and voice notes on jobs; transcripts
generated; office reviews and approves. **Peter approves items before any
marketing use.** The publishing half (Drive hub sync + agent handoff, §9) is
designed here but deliberately NOT built yet — next conversation.

Pressure-tested 2026-07-16 (first-hand recon; the parallel research agents were
blocked by API 529s all evening — findings below are code-verified, not assumed):

- **Correction vs v0.9:** transcription does NOT ride `ai_jobs` — that table is
  constraint-locked to cubic surveys (`survey_id NOT NULL`, kind check,
  composite FK to `cubic_survey_media`, 0031_ai_cubic_survey.sql:220-245).
  Relaxing it risks a proven pipeline for no gain. → dedicated 5-min cron
  reusing `analyseGeminiMedia()` (lib/ai/gemini.ts:141 — takes sourceUrl/bytes/
  mime/model/schema/prompt, handles resumable provider upload + cleanup).
- **Correction vs v0.9:** in-sheet custom video viewfinder dropped. Photos AND
  video both use the native capture input (`<input capture="environment">` —
  the field-proven crew-notes path, components/crew/job-notes.tsx:226-236);
  the system camera gives zoom/torch/stabilisation for free and sidesteps every
  iOS-PWA getUserMedia quirk. Voice notes are the only custom recorder
  (MediaRecorder audio, container runtime-detected via `isTypeSupported` —
  Safari mp4/AAC, Android webm/opus, both Gemini-fine).
- Verified reusable: client-side storage upload + server-side path validation
  (app/actions/job-notes.ts), TUS resumable client (lib/storage/tus-upload.ts)
  for big videos, signed-URL display, Drive hub `08 Media Library/real/jobs/`
  exists, social agents' real-photo class reads folders listed in brand.md
  (plan_week.py:770 `media_library()`) → publishing phase needs no agent code.

## 1. UX (one-thumb, camera-first — CompanyCam's zero-filing lesson)

**Entry points:** fixed camera FAB (56px, mm-red, safe-area aware, capture count
badge) on `/my-jobs/[id]` (crew) and a "Capture" action on the lead page action
bar (office/estimator). Job context auto-attaches — no filing decisions ever.

**Capture sheet** (full-screen overlay, charcoal, `100dvh`, bottom controls):
- Mode segmented control: **Photo · Video · Voice** (Photo default, persists).
- Photo/Video → native camera via hidden input (`accept="image/*"` multi /
  `accept="video/*"` single, `capture="environment"`). Photos downscaled
  client-side (~2000px JPEG); videos ≤300MB guard.
- Voice → hold-to-record button (WhatsApp ergonomics): live timer + pulsing
  ring, slide-up-to-lock for hands-free, release/stop → instant playback +
  keep / re-record. 3-min cap. 10ms haptic on start/stop.
- **Tray**: captured items as thumbnails with per-item progress; photos/audio via
  `supabase.storage.upload`, video via TUS (resumable — van-doorway signal safe).
  Retry chip on failure; leaving the sheet never cancels an upload in flight.
- **Optional enrichment** per item (never blocks save): tag chips Before / After
  / Access / Team / Story + one-line caption.
- **Consent**: sheet header shows the job's consent state. If unset, first
  capture shows a one-time bottom card: "Exteriors, van and crew are always
  fine. For inside the home, ask the customer" + [Customer's OK'd photos]
  [Keep internal-only] setting `leads.media_consent`. Items stamp
  `consent_state` at capture time; non-consented items cannot be approved.
- House rules: ≥44px targets, 16px inputs, press-scale 0.97, 150–300ms
  transitions, `prefers-reduced-motion`, toasts for filed/failed.

**Two taps from job page to filed photo. Capture always wins over metadata.**

## 2. Data model — migration `0050_job_media.sql`

```sql
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
  attached_to uuid references public.job_media(id) on delete set null,
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
  synced_at timestamptz,          -- Drive sync stamp (publishing phase)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- indexes: (lead_id, created_at desc); (transcript_status) where pending/failed;
-- (marketing_approved_at) where not null and synced_at is null
-- trigger set_updated_at; RLS: is_staff() select+insert; is_office() update;
-- is_admin() delete. Bucket 'job-media' (private): staff insert/select own
-- uploads mirror of job-photos policies (0028); delete admin-only.
alter table public.leads add column media_consent text not null default 'unset'
  check (media_consent in ('unset','granted','internal_only'));
```

Paths: `job-media/<leadId>/<uuid>.<ext>` — server actions re-validate the path
prefix against the lead (the job-notes pattern) so a row can never point at
another customer's file.

## 3. Server actions — `app/actions/job-media.ts`

- `recordJobMediaAction(leadIdOrAppointmentId, items[])` — auth staff-active;
  resolve lead/client via appointment when called from /my-jobs (server-side
  anchor resolution, never trust the client); validate every path prefix +
  kind/ext; insert rows (consent from `leads.media_consent`, audio rows get
  `transcript_status='pending'`); one timeline activity ("Freddy's crew added
  3 photos + a voice note"); revalidate lead + job pages.
- `discardJobMediaUploadAction(anchor, path)` — bin an uploaded-but-unrecorded
  object (tray remove) — path-validated, refuses paths already recorded.
- `updateJobMediaAction(id, {caption?, tag?})` — office or the capturer.
- `setLeadMediaConsentAction(leadId, state)` — staff; timeline-logged.
- `approveJobMediaAction(id, approve: boolean)` — OFFICE; refuses when
  `consent_state='internal_only'`; stamps approved_at/by; timeline-logged.
- `deleteJobMediaAction(id)` — office; removes storage object + row.
- `jobMediaSignedUrlsAction` is NOT an action — review surfaces get signed URLs
  server-side at render (1h), the crew tray uses local object URLs.
- Video TUS target: `createJobMediaUploadTargetAction(anchor, {ext,mime,bytes})`
  → mints the resumable endpoint for bucket `job-media` (mirrors the AI-survey
  media-store target so `uploadToMediaTarget()` is reused unchanged).

## 4. Transcription — `app/api/cron/job-media-transcribe/route.ts`

Every 5 min (cron.d + `lib/cron/jobs.ts` registry entry, maxAge 30):
claim up to 5 rows (`kind='audio' and transcript_status in
('pending','failed') and transcript_attempts < 3` via conditional
UPDATE → 'running'); for each: 1h signed URL → `analyseGeminiMedia({
sourceUrl, bytes, mime, model: 'gemini-3.1-flash-lite', schema:
z.object({ transcript: z.string() }), prompt: UK-English verbatim
transcription, filler words dropped })` → stamp `transcript`/'done';
errors → 'failed' + attempts++ (terminal failure surfaces in the review
UI, never alerts — pennies-level, non-critical). Costs logged via run
summary (tokens in/out).

## 5. Review — lead page card + `/content` queue (office)

- **Lead page**: "Job content" card (Overview) — thumbnail grid with kind
  badges, tap → lightbox (photo) / player (video/audio + transcript below),
  caption/tag editing, consent toggle, per-item Approve.
- **`/content`** (nav: Customers group → "Content"): newest-first review queue
  across all jobs — filters (needs-review / approved / internal-only, kind),
  job link, transcript preview, one-tap Approve / Internal-only, bulk approve
  per job. Empty state explains the flow. This is Peter's approval surface.
- Weekly digest: `captured this week` counter joins the attention/metrics rows
  (one-line change, after field validation).

## 6. Consent + privacy invariants

- `consent_state='internal_only'` rows: approve action refuses, UI shows lock.
- Toggle lives on lead page + capture sheet; changes only affect FUTURE
  captures (stamped at capture time) — flipping to granted lets the office
  re-approve past items ONLY by explicitly re-stamping each (deliberate friction).
- T&Cs review adds the media clause (photography for records/marketing, opt-out).
- Media follows job retention thinking; deletion is office-level, audit-logged.

## 7. Build order (this pass)

A. Migration 0050 (dev + prod) + regenerate types
B. `lib/job-media.ts` (constants, path/kind validation, pure helpers + tests)
C. Actions (§3)
D. Capture sheet + voice recorder components; mount on /my-jobs/[id] + lead page
E. Transcribe cron + registry + cron.d line
F. /content page + lead-page card + nav entry
G. Gates (tsc/lint/vitest/build) → deploy → browser smoke (crew + office)
H. Field pass on real phones (Connor iPhone + crew Android) — checklist:
   standalone-mode mic permission behaviour, HEIC photos, video >100MB on 4G,
   voice-note container per device, FAB reachability one-handed.

## 8. Success measures

≥5 captures per completed job in month 1; photo filed ≤2 taps; voice-note
transcript within 5 min; zero non-consented items approved (by construction).

## 9. Publishing phase (designed, NOT in this build — next conversation)

Nightly i9 task reads `marketing_approved_at not null and synced_at is null`
via PostgREST + signed URLs → files to Drive hub:
`08 Media Library/real/jobs/approved/` (flat pool, `date_ref_tag_seq` names)
+ `real/jobs/<YYYY-MM>_<quote-ref>/` archive + `transcripts.md` (voice-note
text + captions as copywriter context). `approved/` gets listed in
brands/marley-moves/brand.md "Image reference assets" → the social agents'
real-photo class and the GBP pipeline consume it with zero agent code changes.
VPS never holds Drive credentials (narrow-token principle); i9 owns `F:`.
Stamp `synced_at` back via PostgREST. Drafting/publishing flow discussion
(what the agents make of it, Peter's approval loop there) — next session.
