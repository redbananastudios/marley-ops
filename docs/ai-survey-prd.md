# AI-Assisted Cubic Survey ("AI Surveyor") — PRD v2.1, build-ready

**Status:** LOCKED for build — decisions confirmed by Peter 2026-07-11; production-hardening review incorporated 2026-07-11.
**Supersedes:** the ChatGPT draft PRD (PLAN.md). Every technical claim in this document was verified against the live codebase, the live VPS, and current provider documentation on 2026-07-11 (7-agent recon + manual credential check). Where this document contradicts the old draft, this document wins.
**Audience:** the implementing engineer/agent ("codex"). This is the single source of truth for the build. Section 13 lists the house conventions that MUST be followed.

## Locked decisions (Peter, 2026-07-11)

1. **Gemini only in V1.** Z.AI dropped (its ASR has no timestamps + 30s cap; video token pricing undocumented; JSON mode unofficial on VLMs). Provider stays swappable via the AI SDK abstraction — do not hard-code Gemini types outside `lib/ai/`.
2. **Import cap 500 MB/file** (not 1 GB). Guided clips cap at 2 minutes / ~50 MB.
3. **Retention: 30 days after the lead reaches a terminal state** (completed/declined); 90 days for abandoned drafts. Enforced by a daily cron. `legal_hold` blocks deletion.
4. **Models: default `gemini-3.5-flash`; `gemini-3.1-flash-lite` remains an admin-selectable economy model.** The non-gating transport smoke found that Flash-Lite twice omitted a clearly visible and narrated television while 3.5 Flash found it. Accuracy is worth the ≈$0.29/≈£0.21 per-survey premium. If an admin deliberately selects Flash-Lite, low-confidence/problem rooms auto-escalate to 3.5 Flash. Both IDs remain configurable in Settings without deploy.
5. **V1 is estimator-only.** The existing manual customer survey at `/cv/[token]` is untouched. Customer AI capture is V2, gated on V1 acceptance criteria.
6. **Newly recorded clips are not promised to survive tab closure before upload completes.** TUS resumes network interruptions while the source `Blob` still exists, but its URL store does not persist the video bytes. The estimator is warned to keep the page open; closing early may require a retake. IndexedDB blob persistence is deliberately out of V1.
7. **The Phase 0 spike uses two real room clips recorded on the estimator iPad.** At least one must be a representative 30–90 second walkthrough; an owner-approved, genuinely small/low-inventory room may be 10–29 seconds. Marley supplies both to a private, git-ignored local fixture folder; generic stock footage cannot pass the catalogue-quality gate.
8. **The AI stack is environment-portable.** AI video and frame access goes exclusively through `lib/storage/media-store.ts`; V1 ships the `supabase` driver, and a future `s3` driver targets Cloudflare R2. `AI_MEDIA_STORAGE_DRIVER=supabase|s3` selects the driver. Job processing lives in trigger-agnostic `lib/ai/jobs.ts`; hosting routes only invoke it. Migration 0031 is standard PostgreSQL, while provider-specific storage provisioning is isolated in migration 0032.

---

## 1. Summary

Add an AI-assisted mode to the existing cubic survey (`/leads/[id]/cubic`). The estimator walks the property recording short room videos on their tablet (or imports videos the customer sent). Gemini analyses each video — visuals **and** narration in one pass — and proposes an itemised inventory mapped **only** to Marley's existing 218-item catalogue. The estimator reviews exceptions, confirms each room, and the confirmed lines merge into the existing canonical survey — which already drives total ft³, the van recommendation, the quote Vehicle step pre-select, and the crew volume line. Nothing downstream changes.

**Product bar (Peter):** efficient, intuitive, informative, and very simple for a non-technical person. The estimator never sees "jobs", "queues", or "tokens" — they see "Analysing your video… about a minute."

### V1 goals

- Guided room-by-room recording + photo/video import, from authenticated Marley Ops on iPad Safari and Android Chrome.
- AI itemisation constrained to the catalogue; the **server owns all cubic volumes** — the model can never invent a ft³ number.
- Estimator review of exceptions + per-room confirmation; bulk-accept for high-confidence items.
- Raw ft³ → deterministic confidence contingency → planning ft³ → the existing `recommendVans()`.
- Manual survey remains fully available at every moment; AI is additive and can be abandoned mid-flow with nothing lost.
- No AI output ever silently overwrites human edits (rides the existing optimistic-concurrency machinery).
- Hard spend caps with a kill switch.

### V1 is proven when (acceptance gates — unchanged from draft, they were good)

- ≥95% of valid capture sessions upload and reach a reviewable result.
- Median raw-volume error ≤15% vs estimator ground truth; **no accepted-quality survey underestimates confirmed volume by >10%**.
- Median estimator review time ≤60s (excluding processing wait).
- Missing rooms / unusable footage / unresolved high-volume items **fail closed** (no vehicle recommendation shown).
- First 30 real estimator surveys complete in shadow rollout with the gates above holding.

---

## 2. Verified platform facts (recon 2026-07-11 — build against these numbers)

| Fact | Verified value | Consequence |
|---|---|---|
| `GEMINI_API_KEY` | EXISTS in `credentials.env` and the primary checkout `.env.local` (`AIzaS…`); both required stable models are exposed; Vercel Production configured 2026-07-11; feature Preview awaits a remote branch | Worktree-local spike injects the central credential without committing it; after the feature branch is pushed, add the key only to that branch's Preview environment; confirm paid billing |
| Gemini video ingestion | Files API: 2 GB/file, 20 GB/project, 48 h retention, resumable upload, **free**; signed HTTPS URLs ≤100 MB also accepted | **Always use Files API** (single code path, no URL leak to third parties); signed-URL direct ingest is an optimisation, not the design |
| Gemini video tokens | ~300 tok/s default res (258 frame + 32 audio), ~100 tok/s low res; 1 fps sampling | 12-min survey ≈ 216k input tokens |
| Gemini cost | 3.1 Flash-Lite $0.25/$1.50 per 1M (stable); 3.5 Flash $1.50/$9.00 (stable) | Full survey ≈ **$0.35 default** / ≈ $0.06 economy. £2/survey cap = ≈8× margin at the default model, keep as circuit breaker |
| Gemini audio | Native audio understanding inside video — narration understood in context | **No ASR stage exists in this design** |
| Gemini timestamps | MM:SS references documented, ±1 s (1 fps) | Evidence = timestamps; frames matched client-side |
| Gemini structured output | `responseSchema` supported; non-gating mock-room transport smoke passed 2026-07-11 on both models (video + narration attribution, structured output, sane timestamps, explicit deletion) | Phase 0 MUST still validate catalogue accuracy on the two real estimator iPad clips before any UI work |
| Gemini bounding boxes | Images only (0–1000 normalised `box_2d`); **not** on video | Grounded replay = feature-flagged image-pass on evidence frames, default OFF |
| Gemini data use | UK/EEA: no-training treatment even on free tier; paid tier no-training by terms. No residency commitment (that's Vertex) | DPIA note in §9; acceptable for V1 |
| Supabase storage (vps1) | storage-api **v1.60.4**, `STORAGE_BACKEND=file`, TUS resumable endpoint live internally AND via Kong (`/storage/v1/upload/resumable` → 204), no proxy body limits (Caddy + Kong unlimited) | TUS direct-from-browser works as-is |
| Storage global cap | **`FILE_SIZE_LIMIT=52428800` (50 MiB)** | Phase 0 ops step: raise to 524288000 (500 MiB) in `/opt/rbs/supabase/.env` + recreate storage container; bucket-level limits keep other buckets tight |
| vps1 disk | 75 GB volume, **36 GB free**, shared with Red Taxi staging + all DBs | Retention cron is **load-bearing**; disk gauge goes on the Settings AI card. Dedicated VPS deferred (triggers in §9) |
| Vercel functions | Fluid compute GA: 800 s max duration per route, 2 GB memory default; **4.5 MB limit is inbound-only**; outbound fetch unbounded; I/O wait ≠ active CPU billing | Drainer route `maxDuration = 800`. Uploads never touch Vercel (direct TUS) |
| Vercel Workflows | GA Apr 2026 but weekly releases / API churn | **Not used.** pg jobs table + cron drainer (house pattern) |
| Existing upload pattern | Browser anon-key client → `storage.upload()` direct, RLS-authorised, server action records DB row. No `createSignedUploadUrl` anywhere | AI media follows the same shape, with TUS for resumability |
| Tests / lint | 200 vitest cases (pure-lib only), lint baseline 31 errors / 7 warnings | Gates in §12: existing tests stay green, changed files lint-clean, baseline never grows |
| AI usage in repo | **None** — this is the first LLM integration | `lib/ai/` establishes the conventions |

### Library stack (verified maintained, July 2026)

| Concern | Pick | Why / critical detail |
|---|---|---|
| Resumable upload | **`tus-js-client`** (bare, no Uppy) behind `MediaStore` | Framework-agnostic, no React peer-dep. The Supabase driver derives its TUS endpoint from `SUPABASE_URL` and uses **6 MB chunks** (Supabase requirement), `Authorization: Bearer <session access_token>` (RLS applies), and metadata `{bucketName, objectName, contentType}`. Components and actions never construct storage endpoints. The localStorage fingerprint preserves the upload URL, not an in-memory recorded `Blob`: same-tab network resume works; an imported file can resume after the estimator reselects it; a recorded clip may need retaking after tab closure. One tus client per upload URL (concurrent → 409) |
| Camera recording | **Native `MediaRecorder`** — no wrapper libs (RecordRTC is dead) | iOS Safari ≥14.5 records `video/mp4` H.264+AAC (Gemini-perfect). Detect in order: `video/mp4;codecs=avc1` → `video/mp4` → `video/webm;codecs=vp9` → `video/webm`; persist actual `recorder.mimeType` on the media row. `getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } })` — `ideal` not `exact`. `videoBitsPerSecond: 3_000_000` → 2-min clip ≈ 45 MB. Deliver-on-stop (no `timeslice` reliance on iOS); belt-and-braces `dataavailable` timeout for the known iPad missing-`stop` bug; recording dies on tab background/lock → keep record→review→upload on ONE route |
| Frame extraction | **`<video>` + canvas seek-and-draw** primary; **Mediabunny** for imports the video element won't seek | Just-recorded blobs are always decodable on the device that encoded them. Use `requestVideoFrameCallback` before drawing (Safari seek-paint gotcha). **ffmpeg.wasm is banned** — OOM-kills iPads |
| AI calls | **AI SDK v7** (`ai@7`, `@ai-sdk/google`) | `generateObject` is deprecated — use `generateText({ output: Output.object({ schema }) })`. Files-API URIs (`generativelanguage.googleapis.com/…/files/…`) pass through untouched; any other URL gets auto-downloaded by the SDK (another reason Files API is the only media path) |
| Frame compression | `canvas.toBlob('image/jpeg', 0.8)` at capped resolution; `browser-image-compression` only for user-imported photos | Frames ≤300 KB, ≤1280 px |

---

## 3. Architecture

```
  iPad (estimator, signed in)
  ├─ record room clip (MediaRecorder, 720p/3Mbps, ≤2min)
  ├─ extract ≤40 evidence frames (canvas, 1 per 2s)
  ├─ TUS upload clip + frames → Supabase Storage `survey-media` (direct, RLS)
  └─ finalize → server action registers media row + enqueues job + kicks drainer
                                    │
  Vercel (fra1) ────────────────────┤
  ├─ /api/cron/ai-jobs (drainer, maxDuration 800, */2 cron + immediate kick)
  │    per job: stream clip Supabase→Gemini Files API (chunked, bounded memory)
  │             → poll ACTIVE → generateText(Output.object(schema), fileUri)
  │             → zod-validate → catalogue-validate → write cubic_ai_detections
  │             → escalation re-run only if configured model differs → mark room ready
  ├─ /api/cron/ai-retention (daily media cleanup)
  └─ server actions: rooms, media registration, review resolutions, confirm-merge
                                    │
  Supabase on vps1 ─────────────────┤
  ├─ storage: survey-media bucket (private, 500MB/object, TUS)
  └─ postgres: cubic_survey_rooms · cubic_survey_media · cubic_analysis_runs
               cubic_ai_detections · ai_jobs · ai_spend_months (+ RPCs)
                                    │
  Gemini API ───────────────────────┘
  └─ Files API (48h auto-expiry) + generateContent (video+audio+schema)
```

**Principles:**
- **AI writes to a suggestion layer only** (`cubic_ai_detections`). Canonical inventory (`cubic_surveys.items`) changes exclusively through estimator confirmation, which goes through the existing `saveCubicSurveyAction`-style optimistic-concurrency merge. A stale tab gets the existing conflict banner; the AI can never clobber office edits.
- **The server owns volume.** Detections carry catalogue keys; `unitFt3` is always assigned server-side from `lib/cubic-catalogue.ts`. Any model output containing volume numbers is discarded on validation.
- **One media path.** Every video goes to Gemini via the Files API (free, 48 h auto-delete, no third-party URL exposure). ≤100 MB clips stream whole (45 MB in a 2 GB function is nothing); >100 MB imports stream in 16 MB ranged chunks (`Range` GETs from Supabase → resumable PUTs to Google) — peak memory = one chunk.
- **Fail open to manual.** Every failure state leaves the survey exactly as usable as it is today. The AI mode is a layer, not a gate.
- **Atomic at every irreversible boundary.** Finalise+enqueue, reserve+reconcile spend, complete a worker attempt, and confirm+merge run in transactional RPCs with row locks and idempotency keys. A network retry or worker crash cannot duplicate inventory, jobs, detections or spend.
- **Explicit readiness.** `planning_ready` is true only after the estimator has declared the room manifest complete, confirmed every room, and resolved every blocking exception. Until then, AI surveys show provisional totals but no vehicle recommendation. Manual-only or explicitly abandoned AI surveys retain today's raw-volume recommendation.
- **Estimator/office access only.** AI tables and `survey-media` use `is_office()`, not the broader `is_staff()` role that includes crew. Authenticated office sessions get SELECT only on AI domain tables; all database mutations go through validated server actions using the service role or atomic service-only RPCs. The sole browser write is Storage upload to a pre-registered path owned by the authenticated uploader. Migration 0031 also replaces the existing crew-readable `cubic_surveys` policies with office-only SELECT; its writes already use service actions, and crew job-sheet volume continues through the price-free service loader.
- **One storage seam.** Components, server actions, workers and retention code use `lib/storage/media-store.ts` for resumable/multipart upload initialisation, object writes, signed reads, metadata and deletes. Only a storage driver may call a provider SDK. V1 selects the Supabase driver; Cloudflare R2 is the named S3-compatible scale target.
- **Swappable worker trigger.** `lib/ai/jobs.ts` owns claim/process/heartbeat/complete logic as a plain module. The scheduled HTTP route is a thin authenticated adapter; a future always-on Node process invokes the same exported function without changing processing logic.

---

## 4. Data model — migration `0031_ai_cubic_survey.sql`

Follow house conventions exactly: uuid PKs `gen_random_uuid()`, `created_at/updated_at timestamptz default now()` + the existing `set_updated_at()` trigger, RLS on every AI table (`is_office()` SELECT only; no authenticated table mutations), text status columns with CHECK constraints (not enums — matches `cubic_surveys`). Service-role server actions handle ordinary writes; state/ledger transitions use the service-only transactional RPCs below. Composite constraints prevent room/media/segment/detection references crossing survey boundaries.

### 4.1 `cubic_survey_rooms` — capture-layer rooms (NOT canonical inventory structure)

```sql
create table cubic_survey_rooms (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  name text not null,                        -- "Bedroom 2", "Garage"
  room_type text,                            -- optional hint from a preset list
  floor text,
  sort int not null default 0,
  hidden_storage_checked boolean not null default false,  -- estimator confirmed wardrobes/cupboards shown
  status text not null default 'pending'
    check (status in ('pending','processing','needs_attention','ready','confirmed','failed')),
  coverage text check (coverage in ('good','partial','poor')),
  quality_flags jsonb not null default '[]',              -- validated enum values, aggregated across active media
  quality_warnings jsonb not null default '[]',           -- display-only model notes
  completion_method text check (completion_method in ('ai','manual')),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cubic_survey_rooms (survey_id, sort);
```

Status meaning: `pending` (created, nothing analysed yet) → `processing` (≥1 media job in flight) → `needs_attention` (no active jobs, but ≥1 non-ignored failed clip) → `ready` (every non-ignored media item processed, detections await review) → `confirmed` (AI items merged or estimator explicitly finished the room manually). `failed` = all media failed/ignored with no processed result. Room coverage is the worst `good < partial < poor` value across non-ignored processed media; quality flags are the validated union. Recompute both whenever media is processed, retried or ignored.

### 4.2 `cubic_survey_media`

```sql
create table cubic_survey_media (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  room_id uuid references cubic_survey_rooms(id) on delete set null,  -- null = whole-property import
  kind text not null check (kind in ('room_video','import_video','photo')),
  storage_path text not null unique,         -- <surveyId>/<mediaId>/source.<ext>; server-generated before upload
  mime text not null,
  bytes bigint,
  duration_s numeric(8,1),
  frames jsonb not null default '[]',        -- [{"t": 4.0, "path": "<surveyId>/<mediaId>/frames/0004.jpg"}]
  status text not null default 'uploading'
    check (status in ('uploading','uploaded','processing','processed','failed','ignored','deletion_pending','deleted')),
  coverage text check (coverage in ('good','partial','poor')),
  quality_flags jsonb not null default '[]',
  error text,
  finalized_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cubic_survey_media (survey_id);
```

The server pre-registers the media row and path before the browser receives upload details. All source and frame paths live under `<surveyId>/<mediaId>/…`, allowing storage RLS and finalisation to prove the authenticated uploader owns the exact registered prefix.

### 4.2a `cubic_survey_segments` — persisted whole-property room proposals

```sql
create table cubic_survey_segments (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  media_id uuid not null references cubic_survey_media(id) on delete cascade,
  model_ref text not null,                    -- stable ref emitted by the segmentation response
  proposed_name text not null,
  start_s numeric(8,2) not null,
  end_s numeric(8,2) not null,
  room_id uuid references cubic_survey_rooms(id) on delete set null,
  status text not null default 'proposed'
    check (status in ('proposed','assigned','merged','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (media_id, model_ref),
  check (end_s > start_s)
);
create index on cubic_survey_segments (survey_id, status);
```

Segments are written before review. Every whole-property item must reference one validated `model_ref`; missing, overlapping or out-of-range assignments become blocking exceptions. Rename/merge actions update segment assignment to a real room transactionally.

### 4.3 `cubic_analysis_runs` — one row per model call (audit + spend ledger)

```sql
create table cubic_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  media_id uuid references cubic_survey_media(id) on delete set null,
  model text not null,                       -- "gemini-3.5-flash"
  prompt_version text not null,              -- from lib/ai/prompts.ts PROMPT_VERSION
  purpose text not null check (purpose in ('itemise','escalation','segmentation','grounding')),
  status text not null default 'running'
    check (status in ('running','succeeded','failed')),
  attempt_key text not null unique,            -- job id + attempt + purpose/model; retry idempotency
  input_tokens int, output_tokens int,
  reserved_cost_usd numeric(8,4) not null default 0,
  cost_usd numeric(8,4),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
```

### 4.4 `cubic_ai_detections` — the suggestion layer

```sql
create table cubic_ai_detections (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references cubic_analysis_runs(id) on delete cascade,
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  room_id uuid references cubic_survey_rooms(id) on delete set null,
  segment_id uuid references cubic_survey_segments(id) on delete set null,
  label text not null,                       -- what the model saw: "large corner sofa"
  catalogue_key text,                        -- best match, validated against lib/cubic-catalogue.ts; null = unmatched
  candidates jsonb not null default '[]',    -- [{"key":"living-space:sofa-corner","confidence":0.91}, …] max 3
  qty int not null default 1 check (qty between 1 and 999),
  confidence numeric(3,2) not null default 0,
  moving text not null default 'moving' check (moving in ('moving','staying','uncertain')),
  flags jsonb not null default '{}',         -- {"dismantle":true,"fragile":false} (suggestions only)
  evidence jsonb not null default '{}',      -- video: timestamps; photo: photo/frame ref; optional grounded box
  review_reason text,                        -- null = high-confidence (bulk-acceptable); else why it needs eyes
  state text not null default 'proposed'
    check (state in ('proposed','accepted','edited','rejected','merged')),
  resolution jsonb,                          -- estimator's edit: {"catalogue_key":…,"qty":…,"moving":…,"flags":…}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cubic_ai_detections (survey_id, state);
create index on cubic_ai_detections (room_id);
```

`merged` is terminal: set by the confirm-merge action when the detection's line landed in canonical `items` (so re-confirming a room can never double-add).

### 4.5 `ai_jobs` — the queue

```sql
create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('process_media','reconcile_survey')),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  media_id uuid references cubic_survey_media(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','running','blocked','done','failed','dead','cancelled')),
  idempotency_key text not null unique,      -- e.g. process_media:<mediaId>:<promptVersion>
  attempts int not null default 0,
  max_attempts int not null default 4,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  payload jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on ai_jobs (status, next_run_at);
```

**Claim RPC** (PostgREST can't `FOR UPDATE SKIP LOCKED`; the drainer calls this via admin client `.rpc()`):

```sql
create or replace function claim_ai_jobs(
  worker text,
  batch int default 1,
  lease_seconds int default 300
)
returns setof public.ai_jobs language plpgsql security definer set search_path = '' as $$
begin
  -- Validate worker; park unchanged when disabled; reap expired final attempts;
  -- then claim due/expired work with FOR UPDATE SKIP LOCKED and a bounded lease.
  return query update public.ai_jobs ... returning *;
end;
$$;
revoke all on function public.claim_ai_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_ai_jobs(text, int, int) to service_role;
```

The real migration fully qualifies every identifier; the excerpt is illustrative. The claim checks `business_settings.ai_survey_enabled` before changing any row. V1 claims one job at a time; after completion the route may claim another only when at least 120 seconds of its 800-second budget remains. Each running worker heartbeats its lease. An expired lease is reclaimable; an expired final attempt is atomically marked dead and its room state recomputed. Attempt keys and the transactional completion RPC make overlapping late completion harmless.

Retry semantics (drainer code): on failure increment attempts atomically; when the new count reaches `max_attempts`, set `dead` + one ops alert (`sendOpsAlert` from `lib/comms/dispatch`); otherwise queue with `next_run_at = now() + interval '30s' * 4^(attempts-1)` (30s/2m/8m). Budget/kill-switch blocks use `blocked`, not retry attempts; they can be requeued after a cap raise or re-enable.

Room aggregation never waits forever on a dead clip. When no active job remains: all non-ignored media processed → `ready`; at least one processed plus at least one failed/dead → `needs_attention`; no processed media → `failed`. From `needs_attention/failed`, the estimator can Retry, **Discard failed clip** (media → `ignored`, activity logged), or **Finish room manually**. Manual finish requires no live jobs and every failed clip acknowledged/ignored; it marks the room confirmed with `completion_method='manual'`, resets manifest attestation for reconfirmation, and forces at least 20% contingency in a mixed AI survey. Abandoning AI for the whole survey returns to normal manual 0% behaviour.

### 4.6 `ai_spend_months` — budget ledger

```sql
create table ai_spend_months (
  month date primary key,                    -- first of month
  reserved_usd numeric(10,4) not null default 0,
  spent_usd numeric(10,4) not null default 0,
  alerted_at timestamptz
);

create table ai_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  job_id uuid not null references ai_jobs(id) on delete cascade,
  attempt_key text not null unique,
  month date not null,
  estimated_usd numeric(10,4) not null,
  actual_usd numeric(10,4),
  status text not null default 'reserved'
    check (status in ('reserved','finalised','released')),
  created_at timestamptz not null default now(),
  finalised_at timestamptz
);
```

`reserve_ai_call(survey, job, attempt_key, estimate)` is one SECURITY DEFINER RPC. It locks the month and survey reservation set, reads both caps from `business_settings` internally (the caller cannot supply a cap), checks `spent + reserved` for the month and survey, inserts exactly one reservation, and increments `reserved_usd`. `finalise_ai_call(attempt_key, actual)` and `release_ai_call(attempt_key)` are idempotent RPCs that atomically move the reservation once. A crash leaves a visible reservation that a stale-reservation sweeper releases only when no live job/run owns it. Every RPC has `set search_path = ''`, fully qualified identifiers, `PUBLIC/anon/authenticated` revoked, and execute granted only to `service_role`.

### 4.7 `cubic_surveys` — additive columns

```sql
alter table cubic_surveys
  add column contingency_pct int not null default 0 check (contingency_pct in (0,10,20,30)),
  add column ai_consent jsonb,               -- textVersion + explicit customer agreement + witness + timestamp
  add column legal_hold boolean not null default false,
  add column ai_status text not null default 'not_started'
    check (ai_status in ('not_started','active','ready','complete','abandoned','failed')),
  add column planning_ready boolean not null default false,
  add column room_manifest_complete boolean not null default false,
  add column ai_abandoned_at timestamptz,
  add column ai_consent_withdrawn_at timestamptz,
  add column ai_consent_withdrawn_by uuid references profiles(id),
  add column last_ai_user_activity_at timestamptz,
  add column media_retention_anchor_at timestamptz;
```

An `AFTER UPDATE OF status` lead trigger snapshots `media_retention_anchor_at = now()` on the related survey when a lead enters `completed` or `declined`, and clears it if the lead is explicitly reopened before deletion. Migration 0031 also backfills existing terminal leads, and survey creation/linking initialises the anchor when its lead is already terminal. This is the retention clock; mutable lead `updated_at` is never used.

### 4.8 `CubicLine` — additive fields (in `lib/cubic-survey.ts`, not SQL)

```ts
interface CubicLine {
  // …existing: key, title, category, qty, unitFt3, flags?, note?
  id: string;       // immutable line identity; key is catalogue identity, not UI identity
  room?: string;    // display label, ≤60 chars — grouping only, no FK
  source?: "ai" | "manual";  // absent = manual (all pre-existing lines)
  aiDetectionIds?: string[];   // provenance + merge idempotency, server-validated
}
```

Migration 0031 backfills IDs into every existing canonical line. `sanitizeCubicLines` also assigns a new UUID when it receives a legitimate legacy/customer local draft without one, then returns/persists the normalised line. The builder's edit/step/delete keys change from catalogue `key` to line `id`, allowing the same catalogue item in different rooms. Unknown fields remain stripped; bad `room`/`source`/provenance strips that optional field, not the line. Behaviour remains unchanged for manual surveys, `/cv`, crew views and downstream totals; relevant tests are extended for identity.

### 4.9 Settings — `business_settings` additive columns (house pattern: column-per-setting singleton)

```sql
alter table business_settings
  add column ai_survey_enabled boolean not null default false,        -- master kill switch
  add column ai_grounded_replay_enabled boolean not null default false,
  add column ai_model_default text not null default 'gemini-3.5-flash',
  add column ai_model_escalation text not null default 'gemini-3.5-flash',
  add column ai_survey_cap_gbp numeric(6,2) not null default 2,
  add column ai_monthly_cap_gbp numeric(8,2) not null default 50,
  add column ai_monthly_alert_gbp numeric(8,2) not null default 40;
```

Wire through `lib/settings.ts` (interface + `DEFAULT_SETTINGS` + select string + mapper) per the existing pattern. Model settings render as a server-validated allow-list containing only the two approved IDs, not arbitrary text inputs. GBP→USD for the ledger uses a conservative code constant `USD_PER_GBP = 1.40` in `lib/ai/budget.ts` (caps are circuit breakers, not accounting — precision is not the point).

### 4.10 Provider-specific storage provisioning — migration `0032_supabase_ai_media_storage.sql`

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('survey-media', 'survey-media', false, 524288000);  -- 500 MB
-- RLS on storage.objects for this bucket: select is_office(); insert is_office()
-- only when the object name exactly matches a pre-registered uploading media
-- source path owned by auth.uid(), or its strict frames/*.jpg prefix
```

Migration 0031 contains only standard PostgreSQL application schema and routines. Supabase Storage bucket and `storage.objects` policies live in migration 0032 because they belong to the `supabase` media-store driver and must not make a future PostgreSQL restore provider-dependent.

Bucket-relative paths: source `<surveyId>/<mediaId>/source.<ext>`; frames `<surveyId>/<mediaId>/frames/<t-padded>.jpg`. Storage policy comparisons treat path components as text (never cast attacker-controlled names to UUID), require the registered uploader and `uploading` media state, and allow only the exact source path or strict frames-JPEG prefix. Server actions validate exact paths against the registered media record; the finaliser calls the `MediaStore` metadata method, not a provider SDK or folder `list()`. AI tables expose `is_office()` SELECT only; authenticated users receive no table INSERT/UPDATE/DELETE grants. All mutations use service-role server actions or transactional RPCs. All new SECURITY DEFINER routines fix `search_path`, fully qualify identifiers, revoke `PUBLIC/anon/authenticated`, and grant only `service_role`.

**Ops prerequisite (Phase 0, before the bucket is usable for >50 MB):** raise the global cap on vps1 — `/opt/rbs/supabase/.env` → `FILE_SIZE_LIMIT=524288000`, recreate the `supabase-storage` container. Verified: TUS endpoint already live through Caddy→Kong with no proxy body limits; this env var is the only blocker.

---

## 5. Processing pipeline

### 5.1 Capture limits (locked)

| Limit | Value |
|---|---|
| Guided room clip | ≤2 min, 720p @ ~3 Mbps → ~45 MB (soft-warn at 1:45, hard stop at 2:00) |
| Imported video | ≤500 MB/file; mp4, mov, webm |
| Photos | ≤15 MB each, ≤40 estimator photos/survey; HEIC converted client-side where supported |
| Per survey | ≤20 videos, ≤20 min total video, **≤2 GB total source media** |
| Evidence frames | sample across the entire clip at `max(2 s, duration/40)`, ≤40/room, JPEG ≤300 KB, ≤1280 px |

Admission is checked against server-verified object bytes, not the client report. New AI uploads fail open to manual when the survey has reached 2 GB, live `survey-media` exceeds 25 GB, or the latest health probe reports less than 10 GB disk free. Operations receives an alert; no existing media is deleted to make room.

### 5.2 Job flow — `process_media`

Enqueued by `finalizeMediaUploadAction`; drained by `/api/cron/ai-jobs`.

1. **Budget gate.** Estimate cost from `duration_s` (default-res: `duration × 300 tok/s × model input price` + 3k output tokens). Call atomic `reserve_ai_call()` using the attempt key; it enforces both per-survey and monthly caps including live reservations. Blocked → job `blocked` with `budget_*`; room shows "AI paused (budget)" and stays manually editable.
2. **Ship to Gemini.** Stream the object from Supabase Storage (admin client) to the **Files API** via resumable upload — whole-file for ≤100 MB, 16 MB ranged chunks above. Poll until file state `ACTIVE` (timeout 120 s). Store the `files/…` URI in the job payload (48 h validity ≫ job lifetime).
3. **Analyse.** `generateText({ model, output: Output.object({ schema: detectionSchema }), messages: [system: PROMPT vN, user: [filePart(fileUri), text(roomContext)]] })`. Room context includes: room name/type, the estimator's hidden-storage answer, and — critically — the **catalogue allow-list** (all 218 keys+titles, ~5k tokens; cache-friendly static prefix).
4. **Validate (server-owned, `lib/ai/validate.ts` — pure, tested).** Reject/repair per §5.4. The run row is created before the provider call with the same attempt key. A transactional completion RPC inserts the surviving detections, persists media coverage/quality, aggregates room assessment, finalises actual spend once, advances media/job/room state and records provider-file cleanup. It first rechecks consent: after withdrawal, output is discarded and media/provider copies move to deletion. Retrying the same attempt is a no-op.
5. **Escalate if warranted and possible (once).** If mean confidence <0.55, zod salvage was required, or there are 0 detections on a clip >20 s, compare the current model with `ai_model_escalation`. Re-run only when the IDs differ (normally an admin-selected Flash-Lite run escalating to 3.5 Flash); otherwise continue to estimator review without a duplicate provider call. An escalation creates a new run row with purpose `escalation`; keep whichever run yields more validated detections (ties → higher mean confidence), and mark the loser's detections `rejected` with `review_reason: 'superseded-by-escalation'`.
6. **Room status.** When all the room's media are `processed` → room `ready`; notify nothing (the builder UI polls/refreshes — see §6.5).

`reconcile_survey` (enqueued once, by unique idempotency key, when the last outstanding media job of a survey finishes): groups possible cross-clip duplicates (§5.5), computes normalised quality flags and updates readiness. No model call in V1.

### 5.3 Model output contracts (zod, `lib/ai/survey-schema.ts`)

```ts
const qualityFlagSchema = z.enum([
  "dark", "fast_pan", "blurred", "cluttered_moderate", "cluttered_heavy",
  "occluded", "incomplete_view", "other"
]);

const videoDetectionSchema = z.object({
  roomAssessment: z.object({
    coverage: z.enum(["good", "partial", "poor"]),
    qualityFlags: z.array(qualityFlagSchema).max(6),
    warningNotes: z.array(z.string().max(120)).max(6),
    proposedRooms: z.array(z.object({                      // whole-property imports only
      ref: z.string().min(1).max(40),
      name: z.string().max(60),
      startS: z.number().min(0), endS: z.number().min(0),
    })).max(20).optional(),
  }),
  items: z.array(z.object({
    label: z.string().max(80),                             // what it saw
    catalogueCandidates: z.array(z.object({
      key: z.string(),                                     // MUST be from the provided allow-list
      confidence: z.number().min(0).max(1),
    })).min(0).max(3),
    qty: z.number().int().min(1).max(50),
    moving: z.enum(["moving", "staying", "uncertain"]),    // from narration/visual cues; default moving
    dismantleLikely: z.boolean(),
    fragileLikely: z.boolean(),
    timestampsS: z.array(z.number().min(0)).min(1).max(5), // where it's visible
    segmentRef: z.string().min(1).max(40).optional(),      // required for whole-property imports
    narrationNote: z.string().max(200).optional(),         // "'the piano stays' at 01:12"
  }).max(120)),
});

const photoDetectionSchema = z.object({
  roomAssessment: videoDetectionSchema.shape.roomAssessment.omit({ proposedRooms: true }),
  items: z.array(videoDetectionSchema.shape.items.element.omit({ timestampsS: true, segmentRef: true }).extend({
    photoIndex: z.number().int().min(0),
    box2d: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })).max(120),
});
```

The exact zod composition may be adjusted to AI SDK v7's supported JSON-Schema subset during the spike, but the persisted contracts above are mandatory. A room video inherits its registered `room_id`. A whole-property video must return non-overlapping proposed segments and every item must name a valid `segmentRef`. A photo result references `photoIndex`, never a fabricated timestamp. The prompt (versioned `PROMPT_VERSION` in `lib/ai/prompts.ts`) instructs: itemise furniture/effects room by room; match ONLY against the provided catalogue keys; never estimate sizes or volumes; treat narration as authoritative for moving/staying and hidden contents ("two boxes inside" → add the closest approved box key ×2 with the narration note); do not report fixtures (fitted kitchens, radiators, carpets); one entry per distinct item type per room with qty.

### 5.4 Server validation rules (the model is never trusted)

- Unknown `catalogueCandidates.key` → drop that candidate; if none survive, detection becomes **unmatched** (`catalogue_key = null`, `review_reason: 'no-catalogue-match'`, contributes **0 ft³** until the estimator maps it).
- Volume fields anywhere in output → discarded (schema has none; any smuggled numbers in strings are ignored — volume only ever comes from `catalogueItem(key).ft3`).
- `qty` clamped to 1–50 (a detection wanting more is suspicious → review exception).
- Timestamps clamped to `[0, duration_s]`.
- Whole-property `segmentRef` must map to exactly one persisted, non-overlapping segment containing the evidence timestamp; otherwise the item is a blocking unmatched-room exception.
- Photo evidence validates `photoIndex` against the submitted image list; no timestamp is generated for a still image.
- Free-text warning notes are display-only. Contingency uses only validated `coverage` and `qualityFlags` enums.
- Top candidate ≥0.8 confidence AND qty ≤5 AND moving ≠ uncertain → auto-acceptable (no `review_reason`, included in bulk room-accept). Everything else gets a `review_reason`: `low-confidence` / `no-catalogue-match` / `uncertain-moving` / `high-qty` / `big-item` (any candidate ≥80 ft³ never auto-accepts — a wrong wardrobe costs a van).
- Malformed output (zod fail after one salvage attempt: strip unknown keys, coerce numerics) → run `failed`, normal retry path (fresh generation usually differs).

### 5.5 Deduplication (deterministic, no model calls)

- **Within one model result:** repeated entries with the same catalogue key collapse to one detection only when their evidence points to the same timestamp/segment; otherwise they remain separate.
- **Within room, across different media:** same `catalogue_key` becomes a duplicate group with `review_reason: 'seen-in-multiple-clips'`. The UI proposes `max(quantities)` but the estimator must choose same items (`max`), different items (`sum`) or a corrected quantity. It is never bulk-accepted. This avoids silently undercounting two clips that cover opposite sides of a room.
- **Across rooms:** never auto-merged (two wardrobes in two bedrooms is reality, not duplication).
- **Against existing manual lines:** if canonical `items` already has the same `catalogue_key` with `room` equal to this room's name, the confirm-merge step flags it ("Bedroom 2 already has Wardrobe ×1 — add anyway / increase qty / skip") rather than silently double-adding.

### 5.6 Contingency (deterministic, explainable — `lib/ai/contingency.ts`, pure + tested)

- **10%** — `room_manifest_complete = true`, every declared room `confirmed`, all coverage `good`, no unresolved detections, hidden-storage checked in every room.
- **20%** — all rooms confirmed but any: coverage `partial`, `cluttered_moderate`, whole-property import used, a room completed manually inside an otherwise AI survey, hidden storage unchecked somewhere, or >10% of detections were manually corrected.
- **30%** — any accepted coverage `poor` or `cluttered_heavy` flag — all exceptions must still be resolved.
- **No van recommendation (fail closed)** — the estimator has not attested that all relevant rooms are declared, any declared room is not confirmed, or any unresolved unmatched/big-item/duplicate exception remains.

Written to `cubic_surveys.contingency_pct` and `planning_ready` in the transactional confirm/readiness RPC; recomputed after every relevant correction. **Planning volume = `total_ft3 × (1 + contingency_pct/100)`** feeds `recommendVans()` only when `planning_ready = true`. While AI is active but incomplete, quote/survey surfaces show provisional raw/planning volume with "Complete AI review for vehicle guidance" and no recommendation/pre-select. Manual-only (`ai_status = not_started`) and explicitly abandoned AI surveys keep `contingency_pct = 0` and today's raw-volume recommendation. The crew/job-sheet volume line keeps showing **raw** (what's physically loaded), unchanged. Note: `cubicFillPct` (90%) already discounts van capacity for loading efficiency — that is a *van-side* margin and stacks intentionally with the *inventory-side* contingency; the two answer different questions and both being visible is a feature (iMVE hides both).

### 5.7 Confirm-merge (the only path into canonical items)

`confirmAiItemsAction(surveyId, roomId, baseUpdatedAt)` validates the request then calls service-only transactional `confirm_ai_room(...)`:
1. Load detections for the room in state `accepted`/`edited` (bulk room-accept first promotes all no-`review_reason` `proposed` rows).
2. Build `CubicLine[]`: `key = catalogue_key` (or `custom:<uuid>` + estimator-supplied `unitFt3` for mapped-to-custom items), `qty`, `flags` from resolution, `room = room.name`, `source = 'ai'`, `note = narrationNote`.
3. Run the §5.5 against-manual check; apply the estimator's choices.
4. The RPC locks the survey and room, compares `updated_at = baseUpdatedAt`, and in one transaction merges canonical items, marks detections `merged`, confirms the room, recomputes `contingency_pct/planning_ready`, and inserts the activity. A conflict or any error rolls back everything. The action then `revalidatePath`s lead + quote pages.

Idempotent by construction: stable line IDs + `aiDetectionIds` prevent a detection appearing twice, `merged` detections are excluded, and re-running with a stale token writes nothing. Room rename/delete is blocked after any detection has merged unless an admin transaction also updates every canonical line carrying that room label.

---

## 6. Screens & UX (tablet-first: 44px targets, 16px inputs, no hover-only anything)

The estimator's mental model: **"Record each room → it lists what it saw → I fix the few it flags → done."** Three screens, all hanging off the existing builder route. No new sidebar entries.

### 6.1 Entry — the existing builder (`/leads/[id]/cubic`)

When `ai_survey_enabled`:
- Header gains two buttons: **"AI room scan"** (primary, camera icon) and **"Import video"** (secondary). Manual search-first builder below is byte-for-byte unchanged.
- Once rooms exist, a **Rooms strip** renders between header and builder: one chip per room — name + status ("Recording", "Uploading 64%", "Analysing…", "**Ready to review · 14 items**", "Confirmed ✓ 212 ft³", "Failed — retry"). Tap a `ready` chip → review workspace. `+ Room` chip at the end.
- Lines merged from AI show a small "AI" badge and carry their room label; a **"Group by room"** toggle appears on the line list when any line has a `room` (default stays the current category grouping — zero change for manual-only users).
- First AI action per survey opens the **consent sheet** (§9), records the consent text version and the estimator's witness of the customer's explicit agreement, and stores it to `cubic_surveys.ai_consent`.
- A property-level **"All rooms with moving contents are listed"** attestation controls `room_manifest_complete`. It appears after at least one room exists and must be re-confirmed after adding/deleting/merging a room.
- **"Stop using AI for this survey"** abandons queued/unconfirmed AI work and returns to today's manual behaviour. Confirmed AI lines remain normal editable canonical lines with provenance; raw-volume vehicle guidance resumes with `contingency_pct = 0`. It never deletes confirmed inventory.
- **"Customer withdrew agreement"** is distinct from ordinary abandonment: prevent new AI calls, cancel queued jobs, make in-flight output discard-only, request best-effort Gemini Files deletion, and queue all unheld source/frame media for deletion. Confirmed canonical inventory is retained or removed only through Marley's documented rights-request decision, never silently by this action.

### 6.2 Capture — `/leads/[id]/cubic/scan` (one route: record → review clip → upload, so the camera stream never crosses a navigation)

- **Room picker sheet** (on entry and after each room): existing rooms with status, or "New room" — name field pre-suggested from presets (Living room, Kitchen, Bedroom N auto-increments, Garage, Loft, Shed…), optional floor. One toggle: "Wardrobes/cupboards opened on camera or narrated?" (feeds hidden-storage + contingency).
- **Camera view:** full-screen rear camera, big red record button, timer with 2:00 cap (amber at 1:45), mute toggle (audio ON by default — narration is a first-class input: *"the piano stays"*, *"two boxes in this wardrobe"*), static coverage hints ("pan slowly · open wardrobes · narrate what stays"). **No fake live detections** — a subtle Marley-red scan-line animation communicates "recording for analysis", honestly.
- **On stop:** inline replay + **Use clip** / **Retake**. "Use clip" → frame extraction (~2 s, progress ring) → TUS upload with real progress + pause/resume; upload continues while the estimator moves to the next room inside the same mounted scan flow (uploads are per-room and independent). Leaving with unsent media → confirm dialog (house `sheet-dismiss-confirm` pattern): **"Keep this page open until the upload finishes. If you close it now, you may need to record this room again."**
- Failure honesty: upload failed → chip shows "Upload failed — tap to resume" while the original Blob/File is still available. Imported files can resume after re-selection. A recorded clip lost through tab/browser termination must be retaken; V1 does not claim otherwise.
- Analysis failure chips offer **Retry**, **Discard failed clip**, and **Finish room manually** where valid. A processed sibling clip is never held indefinitely by a dead clip.

### 6.3 Import — dialog on the builder

File picker (mp4/mov/webm, ≤500 MB) → assign to: existing room / new room / **"Whole property"** → TUS upload. Whole-property media analyse with the segmentation prompt; detections arrive grouped under **proposed rooms** which the estimator renames/merges/confirms in review (unassigned proposals block survey confirmation — fail closed). Photos import the same way (photo jobs send images instead of video parts — same schema, same review).

### 6.4 Review — `/leads/[id]/cubic/review?room=<id>`

Two-pane on tablet landscape (stacked portrait):
- **Left: player.** Signed-URL video; tapping any detection seeks to its first timestamp (nearest extracted frame as poster for instant paint). If `ai_grounded_replay_enabled` (default OFF): evidence frames render stored bounding boxes; otherwise a timestamp callout only — never a fabricated box.
- **Right: tabs.**
  - **Needs attention (n)** — only detections with a `review_reason`, worst first. Card: label → matched item + ft³ (from catalogue), candidate picker (the ≤3 candidates + catalogue search + "custom item"), qty stepper, Moving/Staying toggle, dismantle/fragile chips, reason line ("Low confidence" / "No catalogue match" / "'staying' heard at 01:12"). Buttons: **Accept / Reject**. 44px everything.
  - **By room** — every detection grouped; high-confidence ones pre-ticked; **"Accept room (12)"** bulk button per room.
  - **All items** — flat list with search.
- **Sticky bottom bar:** raw/planning totals update live. While incomplete it reads `Provisional raw 850 ft³ · Complete all rooms for vehicle guidance` and shows no van. Only when `planning_ready` is true does it show `Raw 850 ft³ · +10% contingency · Planning 935 ft³ · 2 Lutons`. **"Confirm room"** → atomic merge (§5.7) → next unconfirmed room, or back to the builder when none remain. Unresolved exceptions in the room → button disabled with count ("Resolve 3 items first") — the fail-closed gate made visible.

### 6.5 Progress & freshness

No websockets. The builder/review pages use React Query to poll an authenticated, uncached `GET /api/ai-surveys/state?surveyId=…` Route Handler every 5 s **only while** any room is `processing` (typical clip: analysis lands in 20–60 s). Next 16 Server Actions are mutation endpoints and are not used for queued polling reads. Processing stages shown are real states from the DB, not theatre: Uploading → Queued → Analysing → Ready.

### 6.6 Settings → new "AI Survey" card (`is_office`)

Enable switch (kill switch), model default + escalation (server-validated selects restricted to the two approved model IDs), per-survey & monthly caps (£), this-month spent/reserved + last-6-months mini-table, failed/dead/blocked jobs with retry/requeue controls, retention stats (media count/GB live, next sweep), and vps1 storage disk note. Integration health gains an **AI (Gemini)** row: models-endpoint ping + month spend/reservations + dead-job count.

### 6.7 Explicitly unchanged

Manual builder mechanics · `/cv/[token]` customer survey (V2 only) · quote Step-3 hint & survey card *except* they now use planning volume with the contingency shown · crew job page + job-sheet PDF volume line (raw, price-free) · van pre-select on new drafts (planning volume) · `survey-photos` pipeline.

---

## 7. Server surface (exact names)

**`app/actions/ai-survey.ts`** — all behind `requireOfficeProfile()` (active admin/estimator only), writes via `createAdminClient()`, every mutation inserts an `activities` row where user-meaningful, all return the house `{ ok: true, … } | { ok: false, error }` shape:

| Action | Signature (input → ok payload) | Notes |
|---|---|---|
| `saveAiConsentAction` | `(surveyId, { textVersion, customerAgreed, agreementMethod, acks })` → `{}` | requires explicit agreement; server writes witness profile + timestamp once |
| `createRoomAction` | `(surveyId, { name, roomType?, floor?, hiddenStorageChecked })` → `{ roomId }` | |
| `updateRoomAction` | `(roomId, patch)` → `{}` | rename / hidden-storage / sort |
| `deleteRoomAction` | `(roomId)` → `{}` | blocked if room has `merged` detections |
| `setRoomManifestCompleteAction` | `(surveyId, complete: boolean)` → `{}` | estimator attests all relevant rooms are declared; room structure changes reset it |
| `assignSegmentAction` | `(segmentId, { roomId?, newRoom?, action: 'assign'\|'merge'\|'reject' })` → `{ roomId? }` | whole-property proposed-room review; service transaction |
| `registerMediaAction` | `(surveyId, { roomId?, kind, mime, bytes, durationS? })` → `{ mediaId, storagePath }` | validates caps (§5.1) + mime allow-list; path is server-generated |
| `finalizeMediaUploadAction` | `(mediaId, { frames: {t,path}[] })` → `{}` | reads exact source/frame metadata via Storage `info()`, validates duration/media signatures and aggregate caps, then calls idempotent `finalize_ai_media` to set uploaded+enqueue exactly one job; **kicks the drainer** via `after(() => fetch(APP_URL + '/api/cron/ai-jobs', { headers: { Authorization: Bearer SYNC_CRON_SECRET } }))`; cron is the safety net |
| `resolveDetectionAction` | `(detectionId, { state: 'accepted'\|'edited'\|'rejected', resolution? })` → `{}` | edited catalogue: `{catalogueKey,qty,moving,flags}`; custom: `{title,category,unitFt3,qty,moving,flags}`; all fields server-clamped and `moving:'staying'` maps to `flags.notMoving=true` |
| `acceptRoomDetectionsAction` | `(roomId)` → `{ accepted: n }` | promotes all no-reason `proposed` |
| `confirmAiItemsAction` | `(surveyId, roomId, baseUpdatedAt, conflicts?: {detectionId, choice}[])` → `{ totalFt3, contingencyPct, updatedAt } \| { conflict: true } \| { needsChoices: […] }` | §5.7 |
| `abandonAiSurveyAction` | `(surveyId)` → `{}` | blocks/cancels unstarted AI jobs, marks AI abandoned, keeps any confirmed canonical lines, restores manual raw-planning behaviour |
| `ignoreFailedMediaAction` | `(mediaId)` → `{}` | only failed/dead media with no live worker; media → ignored, room assessment recomputed, activity logged |
| `completeRoomManuallyAction` | `(surveyId, roomId, baseUpdatedAt)` → `{ updatedAt } \| { conflict: true }` | requires failed media acknowledged + no unresolved detections; confirms room manually and recomputes readiness/contingency atomically |
| `withdrawAiConsentAction` | `(surveyId)` → `{}` | writes withdrawal actor/time, cancels queued jobs, makes running attempts discard-only, schedules media/provider-file deletion |
| `retryAiJobAction` | `(jobId)` → `{}` | authorised office user: `failed`/`dead` → queued with attempts reset; `blocked` → queued only after its blocking condition clears |
**Routes:**
- `app/api/ai-surveys/state/route.ts` — authenticated office-only `GET ?surveyId=…`; `Cache-Control: no-store`; returns only room/media status projection for the React Query poll.
- `app/api/cron/ai-jobs/route.ts` — thin hosting adapter only: `export const maxDuration = 800`; auth `requireUserOrCronSecret(req)` plus an office-role check for interactive callers; invokes the exported drainer in `lib/ai/jobs.ts` with a deadline. It contains no claim, processing or provider logic. Returns `{ claimed, done, failed, blocked }`.
- `app/api/cron/ai-retention/route.ts` — daily (§9).
- `vercel.json` — add `{"path": "/api/cron/ai-jobs", "schedule": "*/2 * * * *"}` and `{"path": "/api/cron/ai-retention", "schedule": "30 2 * * *"}`. The 2-min sweep is retry latency only; the kick gives ~instant starts.

**`lib/ai/`** (new — the repo's first LLM code, keep it exemplary):
`gemini.ts` (AI SDK provider from `GEMINI_API_KEY`, allow-listed model ids from settings) · `files.ts` (`MediaStore`→Files-API streaming, whole/chunked + ACTIVE poll + best-effort explicit delete) · `prompts.ts` (`PROMPT_VERSION`, room-video, whole-property, photo prompts, catalogue allow-list block) · `survey-schema.ts` (separate video/photo contracts) · `validate.ts` (§5.4, pure) · `dedup.ts` (§5.5, pure grouping only) · `contingency.ts` (§5.6, pure) · `merge.ts` (detections→CubicLine[], pure) · `budget.ts` (estimates + atomic reservation calls) · `jobs.ts` (plain trigger-agnostic claim/process/heartbeat/complete drainer around the pure parts; callable from an HTTP route or an always-on Node loop).

**`lib/storage/`**: `media-store.ts` is the only public AI-media API and defines the driver contract for upload initialisation, object put/read/metadata, signed GET and delete. `supabase-media-store.ts` is the V1 implementation and the only new AI module allowed to call `supabase.storage.from()`. A future `s3-media-store.ts` implements the same contract for Cloudflare R2 or another S3-compatible service.

**Env:** `GEMINI_API_KEY` (server-only), `GEMINI_API_BASE_URL` (the AI SDK provider endpoint), `AI_MEDIA_STORAGE_DRIVER=supabase|s3`, `AI_MEDIA_STORAGE_ENDPOINT` (optional Supabase storage override), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, and optional `AI_JOBS_KICK_URL` for the post-upload immediate drainer kick. Future S3/R2 endpoints and credentials are environment-only. No storage, app, deployment-platform or provider host is embedded in application code.

---

## 8. Spend controls

Real cost is approximately $0.35/survey on the accuracy-first default model or approximately $0.06 when an admin deliberately selects the economy model. The caps are **circuit breakers against bugs and abuse**, not budget management:

- Per-survey cap £2 (`ai_survey_cap_gbp`) — checked before every model call against the survey's run ledger. Trip → room "AI paused (survey cap)"; manual always available.
- Monthly cap £50 (`ai_monthly_cap_gbp`) — atomic `reserve_ai_call()` includes spent + live reservations; alert at £40 via `sendOpsAlert` once per month using a persisted alert timestamp/flag on the month row.
- Every provider call creates one reservation/run attempt before dispatch and records model, tokens and actual USD. Idempotent finalise/release RPCs reconcile each attempt exactly once; a stale-reservation sweep handles crashed workers.
- Retries, escalation and segmentation all draw from the same reservations — nothing is exempt.
- Kill switch: `ai_survey_enabled = false` hides all AI UI and makes the drainer park jobs untouched (checked at claim time).
- Gemini side: key is on paid Tier 1 (Phase 0 confirms billing); Tier-1 $10-per-10-min rolling spend cap is 2 orders of magnitude above our worst case — irrelevant but noted.

## 9. Privacy, consent, retention (UK GDPR)

- **Consent/witness sheet** before first capture per survey (stored `ai_consent`): display the versioned notice; customer explicitly agrees verbally or digitally to filming + AI processing; audio is explained (mute available); avoid paperwork/photos/people where practical; manual survey offered as alternative. The estimator records `customerAgreed=true`, agreement method, text version, timestamp and their own profile ID as witness. The estimator does not manufacture consent on the customer's behalf. The DPIA confirms the final lawful basis before field rollout. A pre-confirmation withdrawal cancels/blocks new processing and schedules uploaded media for deletion; later rights requests follow Marley's documented privacy process.
- **Processor chain:** footage → Supabase (RBS-controlled, vps1, Germany) → Google Gemini API (paid tier: no training on prompts; UK/EEA no-training treatment contractually; **no residency commitment** — if a future client contract demands EU-resident inference, that's the Vertex AI migration, out of V1 scope). Gemini Files API copies auto-delete at 48 h; we do not rely on that — retention is ours.
- **DPIA:** complete a short UK GDPR DPIA before field rollout (Phase 6 gate). Privacy-policy line for Marley's site noting AI-assisted video surveys + retention period → flag to Peter at Phase 6 (site change, separate repo).
- **Retention cron** (daily 02:30): delete `survey-media` objects + rows when `media_retention_anchor_at` is >30 days old. An incomplete AI survey is an abandoned draft when `ai_status in ('active','ready','failed','abandoned')` and `last_ai_user_activity_at < now() - 90 days`. `last_ai_user_activity_at` is updated only by authenticated estimator actions that change rooms, consent, media registration/finalisation, resolutions, manifest, confirmation, retry/ignore/manual finish or abandonment; polling and worker retries do not extend it. Consent-withdrawn media is deletion-due immediately. `legal_hold = true` skips + logs. Deletes via **Storage API admin client** (never SQL — house lesson). Detections/runs/rooms rows are kept as the small audit trail; only source media + frames are purged. Failures alert ops; Settings shows live media GB and disk free. Mutable `leads.updated_at` is never used as the terminal clock.
- **Dedicated-VPS triggers** (Peter has offered an 8 GB box — deliberately deferred): live media >25 GB sustained, or server-side transcode need (odd-codec imports become common). Either trips → move the storage volume / add the box as a media worker. Not V1.

## 10. Feature flags & rollout

Settings-driven (no deploys to toggle): `ai_survey_enabled` (master, default **false**) · `ai_grounded_replay_enabled` (V1 ships OFF; enable after real-footage frame-alignment checks) · customer AI capture has **no flag** — it does not exist until V2. The grounded image pass, when enabled later, adds `grounding` to run purposes and uses the same reservation/idempotency contract.

Rollout: (1) internal — Peter's own test leads (07572382366 / peter@abacusonline.net contacts only); (2) shadow — Connor/Luke record real surveys AND keep their manual count; we compare, nothing customer-visible changes; (3) gates from §1 hold over 30 field surveys → AI-first becomes the default working style. Rollback at any point = flip `ai_survey_enabled` off; manual survey is untouched throughout; confirmed inventory is never deleted by anything.

**V2 (explicitly out of V1):** customer self-capture on `/cv` (hashed/expiring tokens, public TUS policies, abuse rate-limiting, consent UX, SMS/email notify), grounded-replay default-on, Vertex residency if contractually forced.

## 11. Implementation phases (each ends green: `npx tsc --noEmit` + `npm test` + `npm run build`)

**Phase 0 — Preflight (gates everything; ~half a day)**
1. **Before touching any project file:** fetch latest `master`, verify lineage/clean state, create the dedicated worktree + `codex/ai-surveyor-v1` feature branch, and establish the 200-test/typecheck/build/lint baseline inside it.
2. Link that worktree to the existing Red Banana `marley-ops` Vercel project. Inject `GEMINI_API_KEY` into the local spike process from `credentials.env` (worktrees do not inherit ignored `.env.local`). Verify the existing Production variable; after the feature branch exists remotely, add a branch-scoped Preview variable. Confirm paid billing tier in AI Studio.
3. Marley records two clips on the actual estimator iPad and places them in worktree-local `.private/ai-survey-spike/` (git-ignored; never committed). At least one is 30–90 seconds; an owner-approved small/low-inventory room may be 10–29 seconds. **Spike** `scripts/ai-spike.mjs`: Files API upload → `Output.object(videoDetectionSchema)` on both models → confirm schema honoured with video+audio, timestamps sane, catalogue matching plausible and cost logged. Sanitised JSON responses become committed fixtures; raw home video does not. If schema-with-video misbehaves → fall back to JSON-in-prompt + zod salvage and update this PRD before Phase 1.
4. Only after the AI spike passes: vps1 ops `FILE_SIZE_LIMIT=524288000` + recreate storage container; verify with a >50 MB TUS upload from a browser session (session JWT, 6 MB chunks). Capture before/after service health and rollback instructions.

**Phase 0 AI spike gate: PASSED 2026-07-11.** Two real estimator-device clips were used: an owner-approved 13.5-second low-inventory kitchen and a 45.6-second office walkthrough. All four clip/model calls honoured the structured audiovisual schema, returned only valid catalogue keys with sane timestamps, and explicitly deleted their Gemini File resources. 3.5 Flash matched the visible/narrated kitchen inventory (table, four chairs, American-style fridge-freezer) and identified 13 plausible office items; Flash-Lite materially undercounted both rooms (90 vs 130 ft³ and 105 vs 237 ft³), confirming the accuracy-first 3.5 default. Total measured spike cost was $0.0679. Raw footage and full responses remain git-ignored; only redacted fixtures are committed.

**Phase 1 — Domain & persistence:** standard-PostgreSQL migration 0031 (tables, secure transactional RPCs, settings/survey/retention columns); stable `CubicLine.id` + room/source/provenance + legacy backfill; separate video/photo/segment contracts; pure engines TDD (`validate`, duplicate grouping, contingency, merge, budget) with spike fixtures; `MediaStore` contract/factory and trigger-agnostic jobs boundary.
**Phase 2 — Capture & upload:** provider-specific migration 0032 (Supabase bucket/path-bound office RLS); `/scan` route (MediaRecorder + frames + tus), import dialog, consent sheet, rooms strip, `registerMedia`/`finalizeMedia` actions. Every media operation goes through `MediaStore`.
**Phase 3 — Pipeline:** `lib/ai/*` I/O halves, one-at-a-time lease/heartbeat drainer + kick, attempt idempotency, escalation, atomic spend reservations, run ledger, ops alerts.
**Phase 4 — Review & merge:** review workspace, exceptions flow, confirm-merge, planning volume through quote page / Step-3 hint / survey card.
**Phase 5 — Ops:** Settings AI card, integration-health row, retention cron, retry buttons, disk gauge.
**Phase 6 — Verification:** full test sweep; prod E2E at tablet viewport (house pattern: real flow end-to-end on prod with Peter's test contacts, then delete all test state); device matrix below; DPIA; shadow rollout starts.

**Deliberately NOT built (V1):** offline capture/background upload (interface warns before leaving with unsent media — that's it) · real-time on-device detection · mixed-fleet optimiser · LLM-based dedup/reconciliation (deterministic rules only) · separate office approval step (estimator confirmation + validation rules are the gate; office can edit the survey afterwards like any other).

### Portability & future migration

The AI survey subsystem must lift from the current hosting to a dedicated environment without rewriting application data or processing logic. All video and frame operations — resumable or multipart upload initialisation, object put/read/metadata, signed GET and delete — cross the single `MediaStore` interface in `lib/storage/media-store.ts`. V1 uses the Supabase Storage/TUS driver selected by `AI_MEDIA_STORAGE_DRIVER=supabase`; Cloudflare R2 is the named future scale target and will be an `s3` driver selected by configuration. Object keys are provider-neutral and stored unchanged in PostgreSQL. All app, database, storage and AI endpoints come from environment variables. `lib/ai/jobs.ts` owns the full drainer and accepts injected dependencies/deadlines; the scheduled route only authenticates and invokes it, while a future always-on Node worker can call the same function. Migration 0031 is standard PostgreSQL only; provider-specific Supabase Storage provisioning is isolated in migration 0032.

**Migration runbook:** pause new captures and let active jobs drain; take and verify a `pg_dump`, restore it into the target standard PostgreSQL service, and synchronise the `survey-media` objects to Cloudflare R2 while preserving every bucket-relative object key. Configure the target environment (`AI_MEDIA_STORAGE_DRIVER=s3`, database, app URL, storage endpoint/credentials and Gemini variables), deploy the unchanged app plus always-on worker through Coolify, then verify database health, job claiming, signed reads, upload/finalise and deletion against test media. Cut DNS only after those checks pass. Rollback is to restore the previous environment variables/DNS while the source database and bucket remain read-only and intact.

## 12. Test plan

**Unit (house pattern — pure libs in `tests/lib/ai/`):** validate.test (unknown keys dropped, volume smuggling discarded, auto-accept boundaries incl. big-item ≥80 ft³, qty clamps, segment/photo evidence) · dedup.test (cross-media groups require choice, cross-room never merges, against-manual conflicts) · contingency.test (persisted coverage aggregation, moderate/heavy clutter, manual-room floor, manifest/readiness + every fail-closed state) · merge.test (stable line identity, same key in two rooms, provenance, atomic idempotency inputs, custom-item path) · budget.test (estimate, atomic reservation/finalise/release, concurrent survey/month caps, crash recovery) · schema.test (video/photo/segmentation fixtures parse; malformed fixtures fail then salvage where legal) · jobs.test (unique enqueue, lease heartbeat, overlapping stale worker, route time budget, partial/dead media room aggregation, backoff, dead-at-max) · retention.test (terminal anchor, exact user-activity clock, consent withdrawal, legal hold) · frames.test (full-clip sampling + timestamp→nearest-frame matching) · media-store.test (driver selection, provider-neutral keys, Supabase endpoint derivation and mocked put/signed-get/delete) · portability.test (banned host literals absent; direct storage SDK calls confined to the Supabase driver; cron route remains thin). Existing 200 tests stay green; `cubic-survey.test.ts` is extended for IDs and optional fields.

**Database/security integration:** execute migration tests against an isolated Supabase database: crew denied all AI tables/media; estimator/admin allowed only intended operations; preregistered-path upload policy; `PUBLIC/anon/authenticated` cannot execute service RPCs; duplicate finalise/enqueue and confirm calls are no-ops; two concurrent confirmations produce one winner/one conflict; concurrent reservations cannot exceed either cap; retention uses the anchored timestamp and respects legal hold.

**E2E (prod, tablet viewport, test data only, then cleaned):**
1. Record 3 rooms with narration ("sofa stays") → analysed → "stays" item arrives `moving: staying`.
2. Kill the network mid-upload → resume from chunk → completes.
3. Close the tab during analysis → return → room `ready` with detections.
4. Resolve exceptions incl. one unmatched → custom item; confirm room → lines in builder with AI badge + room label; quote Step-3 shows planning-volume van rec.
5. Bulk "Accept room"; verify big-item was NOT bulk-accepted.
6. Whole-property import → segmentation proposals → rename/merge → confirm.
7. Record two clips of the same room → same-key detections form a blocking duplicate group; estimator chooses same items (`max`), distinct items (`sum`) or corrected quantity; no silent merge/undercount.
8. Two tabs: confirm in A, then confirm in B with stale token → conflict banner, no double lines.
9. Poor footage (dark 10 s clip) → warnings → fail-closed (no van rec) until resolved.
10. Trip the per-survey cap (temporarily set to £0.01) → "AI paused", manual unaffected; reset.
11. Kill switch off mid-queue → drainer parks jobs; on → resumes.
12. Retention dry-run against a synthetic old survey.

13. Try to close during a newly recorded upload → explicit retake warning; close during analysis → return safely to ready state.
14. Whole-property import → every item references a persisted segment; assign/merge/reject proposals; no unassigned item can confirm.
15. Photo-only import → evidence uses photo index/optional image box, never a fabricated timestamp.
16. Crew-role session → all AI routes, tables and footage denied.
17. One room has one processed clip and one dead clip → `needs_attention`; discard/retry/manual-finish paths all terminate without duplicate inventory.
18. Withdraw agreement with queued and running work → queued jobs cancel, late output is discarded, media/provider deletion is attempted, legal hold remains authoritative.

**Device matrix (manual):** iPad Safari (the real estimator device) · iPhone Safari · Android Chrome · portrait+landscape · camera/mic permission denied · muted recording · backgrounding mid-record (clip up to that point survives via `dataavailable` fallback).

## 13. House conventions the implementer MUST follow (from the live codebase)

- Server actions: AI actions use a dedicated `requireOfficeProfile()` gate that verifies active `admin|estimator` role on every directly POST-reachable action → zod-parse input → resource-ownership check → mutate via `createAdminClient()` → return `{ ok: true, … } | { ok: false, error }`. Never copy the broader active-profile helper that admits crew, and never trust client-computed totals/paths — recompute/validate server-side (see `saveCubicSurveyAction`).
- Optimistic concurrency: `.eq("updated_at", baseUpdatedAt)` + `.select().maybeSingle()`; empty result = conflict, surface the reload banner.
- RLS: AI tables get `is_office()` SELECT only; all table mutations use the service role, and no authenticated job/detection/spend write can bypass transactional boundaries. `cubic_surveys` becomes office-only; crew consumes raw volume only through the existing price-free service loader. Every SECURITY DEFINER RPC uses a fixed empty `search_path`, fully qualified identifiers, revokes `PUBLIC/anon/authenticated`, and grants only `service_role`. Settings remain behind `is_office()`.
- Storage: every AI-media call uses `lib/storage/media-store.ts`; only the selected driver may call a provider SDK. Browser uploads direct (session identity + provider policy) only to a pre-registered `<surveyId>/<mediaId>/…` prefix owned by that office profile; server verifies exact object metadata/paths; deletes use the driver API, never SQL; display uses the driver's signed GET. Cloudflare R2 is the future S3 scale target.
- Migrations: numbered `00NN_name.sql`; 0031 must remain standard PostgreSQL, and provider-specific storage setup stays in 0032. Apply to production only after local sign-off via psql-over-SSH + `notify pgrst, 'reload schema'`.
- UI: Marley tokens (`mm-red` accents, one per surface), `INPUT_H = h-11`, 44 px touch targets, 16 px inputs, `focus-ring`, pills/chips per existing status badges; user-meaningful mutations insert `activities` rows; `revalidatePath` the affected lead/quote pages.
- Timestamps in user-facing UK copy; no em-dashes in customer-facing strings; UK English.
- Commits: small, per-phase, `--author="Peter Farrell <peter@redbananastudios.com>"`; explicit-path staging only; deploy = push → Vercel API → verify prod sha; test on prod with Peter's own contacts only (07572382366 / peter@abacusonline.net), never real customers, and remove all test state after.

## 14. Verified references

Gemini: [pricing](https://ai.google.dev/gemini-api/docs/pricing) · [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) · [Files API](https://ai.google.dev/gemini-api/docs/files) · [file input methods (100 MB URL cap)](https://ai.google.dev/gemini-api/docs/file-input-methods) · [structured output](https://ai.google.dev/gemini-api/docs/structured-output) · [terms (UK no-training)](https://ai.google.dev/gemini-api/terms). Libraries: [tus-js-client](https://github.com/tus/tus-js-client) · [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) · [Mediabunny](https://github.com/Vanilagy/mediabunny) · [AI SDK v7](https://vercel.com/blog/ai-sdk-7) · [v6→7 migration (generateObject deprecation)](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0). Vercel: [function limits](https://vercel.com/docs/functions/limitations) · [maxDuration](https://vercel.com/docs/functions/configuring-functions/duration) · [cron](https://vercel.com/docs/cron-jobs/usage-and-pricing). Prior art (pattern reference only): [Yembo visual inventory UX](https://yembo.ai/moving/visual-inventory) · [AI-Moving-Cost-Estimator](https://github.com/Nazmul0005/AI-Moving-Cost-Estimator). VPS facts: recon 2026-07-11 (storage-api v1.60.4, TUS 204 public+internal, FILE_SIZE_LIMIT 50 MiB, 36 GB free).
