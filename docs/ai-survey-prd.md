# AI-Assisted Cubic Survey ("AI Surveyor") — PRD v2, build-ready

**Status:** LOCKED for build — decisions confirmed by Peter 2026-07-11.
**Supersedes:** the ChatGPT draft PRD (PLAN.md). Every technical claim in this document was verified against the live codebase, the live VPS, and current provider documentation on 2026-07-11 (7-agent recon + manual credential check). Where this document contradicts the old draft, this document wins.
**Audience:** the implementing engineer/agent ("codex"). This is the single source of truth for the build. Section 14 lists the house conventions that MUST be followed.

## Locked decisions (Peter, 2026-07-11)

1. **Gemini only in V1.** Z.AI dropped (its ASR has no timestamps + 30s cap; video token pricing undocumented; JSON mode unofficial on VLMs). Provider stays swappable via the AI SDK abstraction — do not hard-code Gemini types outside `lib/ai/`.
2. **Import cap 500 MB/file** (not 1 GB). Guided clips cap at 2 minutes / ~50 MB.
3. **Retention: 30 days after the lead reaches a terminal state** (completed/declined); 90 days for abandoned drafts. Enforced by a daily cron. `legal_hold` blocks deletion.
4. **Models: default `gemini-3.1-flash-lite`, auto-escalation to `gemini-3.5-flash`** for low-confidence rooms. Both configurable in Settings without deploy.
5. **V1 is estimator-only.** The existing manual customer survey at `/cv/[token]` is untouched. Customer AI capture is V2, gated on V1 acceptance criteria.

---

## 1. Summary

Add an AI-assisted mode to the existing cubic survey (`/leads/[id]/cubic`). The estimator walks the property recording short room videos on their tablet (or imports videos the customer sent). Gemini analyses each video — visuals **and** narration in one pass — and proposes an itemised inventory mapped **only** to Marley's existing 219-item catalogue. The estimator reviews exceptions, confirms each room, and the confirmed lines merge into the existing canonical survey — which already drives total ft³, the van recommendation, the quote Vehicle step pre-select, and the crew volume line. Nothing downstream changes.

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
| `GEMINI_API_KEY` | EXISTS in `credentials.env` (`AIzaS…`), **not yet** in marley-ops envs | Phase 0 wires it into `.env.local` + Vercel (both marley-ops envs) |
| Gemini video ingestion | Files API: 2 GB/file, 20 GB/project, 48 h retention, resumable upload, **free**; signed HTTPS URLs ≤100 MB also accepted | **Always use Files API** (single code path, no URL leak to third parties); signed-URL direct ingest is an optimisation, not the design |
| Gemini video tokens | ~300 tok/s default res (258 frame + 32 audio), ~100 tok/s low res; 1 fps sampling | 12-min survey ≈ 216k input tokens |
| Gemini cost | 3.1 Flash-Lite $0.25/$1.50 per 1M (stable); 3.5 Flash $1.50/$9.00 (stable) | Full survey ≈ **$0.06** default / ≈ $0.35 all-escalated. £2/survey cap = 10–30× margin, keep as circuit breaker |
| Gemini audio | Native audio understanding inside video — narration understood in context | **No ASR stage exists in this design** |
| Gemini timestamps | MM:SS references documented, ±1 s (1 fps) | Evidence = timestamps; frames matched client-side |
| Gemini structured output | `responseSchema` supported; no official video+schema example | Phase 0 spike MUST validate schema-with-video on real clips before any UI work |
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
| Resumable upload | **`tus-js-client`** (bare, no Uppy) | Framework-agnostic, no React peer-dep. **`chunkSize` MUST be 6 MB** (Supabase hard requirement). Endpoint `https://supabase.redbananastudios.com/storage/v1/upload/resumable`, `Authorization: Bearer <session access_token>` (RLS applies), metadata `{bucketName, objectName, contentType}`. localStorage fingerprint gives tab-close resume free. One tus client per upload URL (concurrent → 409) |
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
  │             → escalation re-run if low confidence → mark room ready
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

---

## 4. Data model — migration `0031_ai_cubic_survey.sql`

Follow house conventions exactly: uuid PKs `gen_random_uuid()`, `created_at/updated_at timestamptz default now()` + the existing `set_updated_at()` trigger, RLS on every table (`is_staff()` select/insert/update, `is_admin()` delete unless stated), text status columns with CHECK constraints (not enums — matches `cubic_surveys`).

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
    check (status in ('pending','processing','ready','confirmed','failed')),
  quality_warnings jsonb not null default '[]',           -- ["dark footage","fast panning"]
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cubic_survey_rooms (survey_id, sort);
```

Status meaning: `pending` (created, nothing analysed yet) → `processing` (≥1 media job in flight) → `ready` (all media analysed, detections await review) → `confirmed` (estimator confirmed the room; its accepted detections were merged). `failed` = all media for the room failed after retries (room stays manually editable).

### 4.2 `cubic_survey_media`

```sql
create table cubic_survey_media (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  room_id uuid references cubic_survey_rooms(id) on delete set null,  -- null = whole-property import
  kind text not null check (kind in ('room_video','import_video','photo')),
  storage_path text not null,                -- survey-media/<surveyId>/<roomId|imports>/<uuid>.<ext>
  mime text not null,
  bytes bigint,
  duration_s numeric(8,1),
  frames jsonb not null default '[]',        -- [{"t": 4.0, "path": "<surveyId>/<mediaId>/frames/0004.jpg"}]
  status text not null default 'uploading'
    check (status in ('uploading','uploaded','processing','processed','failed','deleted')),
  error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cubic_survey_media (survey_id);
```

### 4.3 `cubic_analysis_runs` — one row per model call (audit + spend ledger)

```sql
create table cubic_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references cubic_surveys(id) on delete cascade,
  media_id uuid references cubic_survey_media(id) on delete set null,
  model text not null,                       -- "gemini-3.1-flash-lite"
  prompt_version text not null,              -- from lib/ai/prompts.ts PROMPT_VERSION
  purpose text not null check (purpose in ('itemise','escalation','segmentation')),
  status text not null default 'running'
    check (status in ('running','succeeded','failed')),
  input_tokens int, output_tokens int,
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
  label text not null,                       -- what the model saw: "large corner sofa"
  catalogue_key text,                        -- best match, validated against lib/cubic-catalogue.ts; null = unmatched
  candidates jsonb not null default '[]',    -- [{"key":"living-space:sofa-corner","confidence":0.91}, …] max 3
  qty int not null default 1 check (qty between 1 and 999),
  confidence numeric(3,2) not null default 0,
  moving text not null default 'moving' check (moving in ('moving','staying','uncertain')),
  flags jsonb not null default '{}',         -- {"dismantle":true,"fragile":false} (suggestions only)
  evidence jsonb not null default '{}',      -- {"timestamps":[12,47],"note":"narration: 'wardrobe stays'"}
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
    check (status in ('queued','running','done','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 4,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  payload jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on ai_jobs (status, next_run_at);
```

**Claim RPC** (PostgREST can't `FOR UPDATE SKIP LOCKED`; the drainer calls this via admin client `.rpc()`):

```sql
create or replace function claim_ai_jobs(worker text, batch int default 3)
returns setof ai_jobs language sql security definer as $$
  update ai_jobs j
     set status = 'running', locked_at = now(), locked_by = worker, updated_at = now()
   where j.id in (
     select id from ai_jobs
      where status = 'queued' and next_run_at <= now()
      order by created_at
      limit batch
      for update skip locked)
  returning j.*;
$$;
revoke execute on function claim_ai_jobs from anon, authenticated;  -- service-role only
```

Retry semantics (drainer code): on failure `attempts+1`; if `attempts >= max_attempts` → `dead` + ops alert (`sendOpsAlert` from `lib/comms/dispatch`); else `queued` with `next_run_at = now() + interval '30s' * 4^attempts` (30s/2m/8m). A `running` job whose `locked_at` is >15 min old is reclaimed as stale (function crash cover) — the claim query treats it as queued: add `or (status='running' and locked_at < now() - interval '15 minutes')` to the claim WHERE.

### 4.6 `ai_spend_months` — budget ledger

```sql
create table ai_spend_months (
  month date primary key,                    -- first of month
  spent_usd numeric(10,4) not null default 0
);

create or replace function reserve_ai_spend(p_month date, p_est numeric, p_cap numeric)
returns boolean language sql security definer as $$
  insert into ai_spend_months (month, spent_usd) values (p_month, p_est)
  on conflict (month) do update
    set spent_usd = ai_spend_months.spent_usd + excluded.spent_usd
    where ai_spend_months.spent_usd + excluded.spent_usd <= p_cap
  returning true;
$$;
```

Returns null row (falsy) when the cap would be exceeded → the job parks as `failed` with error `budget_monthly_cap` (retryable next month or after a cap raise; never `dead`-alerts more than once — see §8). After each run, reconcile: `spent_usd += (actual − estimate)`. Per-survey cap enforced in code: `sum(cost_usd) over the survey's runs + estimate ≤ cap`.

### 4.7 `cubic_surveys` — additive columns

```sql
alter table cubic_surveys
  add column contingency_pct int not null default 0 check (contingency_pct in (0,10,20,30)),
  add column ai_consent jsonb,               -- {"byProfileId":…,"at":…,"acks":["filming","audio","personal-items","manual-alternative"]}
  add column legal_hold boolean not null default false;
```

### 4.8 `CubicLine` — additive fields (in `lib/cubic-survey.ts`, not SQL)

```ts
interface CubicLine {
  // …existing: key, title, category, qty, unitFt3, flags?, note?
  room?: string;    // display label, ≤60 chars — grouping only, no FK
  source?: "ai" | "manual";  // absent = manual (all pre-existing lines)
}
```

`sanitizeCubicLines` extends to validate/strip these (unknown fields still stripped; bad `room`/`source` → strip the field, not the line). **Zero behaviour change for existing surveys, the manual builder, `/cv`, crew views, and all 200 existing tests.**

### 4.9 Settings — `business_settings` additive columns (house pattern: column-per-setting singleton)

```sql
alter table business_settings
  add column ai_survey_enabled boolean not null default false,        -- master kill switch
  add column ai_model_default text not null default 'gemini-3.1-flash-lite',
  add column ai_model_escalation text not null default 'gemini-3.5-flash',
  add column ai_survey_cap_gbp numeric(6,2) not null default 2,
  add column ai_monthly_cap_gbp numeric(8,2) not null default 50,
  add column ai_monthly_alert_gbp numeric(8,2) not null default 40;
```

Wire through `lib/settings.ts` (interface + `DEFAULT_SETTINGS` + select string + mapper) per the existing pattern. GBP→USD for the ledger uses a conservative code constant `USD_PER_GBP = 1.40` in `lib/ai/budget.ts` (caps are circuit breakers, not accounting — precision is not the point).

### 4.10 Storage bucket

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('survey-media', 'survey-media', false, 524288000);  -- 500 MB
-- RLS on storage.objects for this bucket: insert/select is_staff(), delete is_admin()
-- (mirror the survey-photos policies in 0001_init.sql:328)
```

Paths: videos `survey-media/<surveyId>/<roomId|imports>/<uuid>.<ext>`; frames `survey-media/<surveyId>/<mediaId>/frames/<t-padded>.jpg`. Server actions validate every client-reported path against the survey's folder prefix (same discipline as `app/actions/job-notes.ts`).

**Ops prerequisite (Phase 0, before the bucket is usable for >50 MB):** raise the global cap on vps1 — `/opt/rbs/supabase/.env` → `FILE_SIZE_LIMIT=524288000`, recreate the `supabase-storage` container. Verified: TUS endpoint already live through Caddy→Kong with no proxy body limits; this env var is the only blocker.

---

## 5. Processing pipeline

### 5.1 Capture limits (locked)

| Limit | Value |
|---|---|
| Guided room clip | ≤2 min, 720p @ ~3 Mbps → ~45 MB (soft-warn at 1:45, hard stop at 2:00) |
| Imported video | ≤500 MB/file; mp4, mov, webm |
| Photos | ≤15 MB each, ≤40 estimator photos/survey; HEIC converted client-side where supported |
| Per survey | ≤20 videos, ≤20 min total video |
| Evidence frames | 1 per 2 s, ≤40/room, JPEG ≤300 KB, ≤1280 px |

### 5.2 Job flow — `process_media`

Enqueued by `finalizeMediaUploadAction`; drained by `/api/cron/ai-jobs`.

1. **Budget gate.** Estimate cost from `duration_s` (default-res: `duration × 300 tok/s × model input price` + 3k output tokens). Check per-survey cap (sum of `cubic_analysis_runs.cost_usd` + estimate), then `reserve_ai_spend()` for the month. Blocked → job `failed` with `budget_*` error; room shows "AI paused (budget)" and stays manually editable.
2. **Ship to Gemini.** Stream the object from Supabase Storage (admin client) to the **Files API** via resumable upload — whole-file for ≤100 MB, 16 MB ranged chunks above. Poll until file state `ACTIVE` (timeout 120 s). Store the `files/…` URI in the job payload (48 h validity ≫ job lifetime).
3. **Analyse.** `generateText({ model, output: Output.object({ schema: detectionSchema }), messages: [system: PROMPT vN, user: [filePart(fileUri), text(roomContext)]] })`. Room context includes: room name/type, the estimator's hidden-storage answer, and — critically — the **catalogue allow-list** (all 219 keys+titles, ~5k tokens; cache-friendly static prefix).
4. **Validate (server-owned, `lib/ai/validate.ts` — pure, tested).** Reject/repair per §5.4. Write one `cubic_analysis_runs` row (tokens + actual cost, reconcile ledger) and the surviving `cubic_ai_detections`.
5. **Escalate if warranted (once).** If mean confidence <0.55, or zod salvage was required, or 0 detections on a clip >20 s: re-run with `ai_model_escalation` (new run row, purpose `escalation`); keep whichever run yields more validated detections (ties → higher mean confidence); mark the loser's detections `rejected` with `review_reason: 'superseded-by-escalation'`.
6. **Room status.** When all the room's media are `processed` → room `ready`; notify nothing (the builder UI polls/refreshes — see §6.5).

`reconcile_survey` (enqueued when the last outstanding media job of a survey finishes): runs the deterministic cross-clip dedup (§5.5) and computes quality warnings. No model call in V1.

### 5.3 Model output contract — `detectionSchema` (zod, `lib/ai/survey-schema.ts`)

```ts
const detectionSchema = z.object({
  roomAssessment: z.object({
    coverage: z.enum(["good", "partial", "poor"]),
    warnings: z.array(z.string().max(120)).max(6),        // "very cluttered", "dark"
    proposedRooms: z.array(z.object({                      // whole-property imports only
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
    narrationNote: z.string().max(200).optional(),         // "'the piano stays' at 01:12"
  }).max(120)),
});
```

The prompt (versioned `PROMPT_VERSION` in `lib/ai/prompts.ts`) instructs: itemise furniture/effects room by room; match ONLY against the provided catalogue keys; never estimate sizes or volumes; treat narration as authoritative for moving/staying and hidden contents ("two boxes inside" → add `bedrooms:box-large` ×2 with the narration note); do not report fixtures (fitted kitchens, radiators, carpets); one entry per distinct item type per room with qty.

### 5.4 Server validation rules (the model is never trusted)

- Unknown `catalogueCandidates.key` → drop that candidate; if none survive, detection becomes **unmatched** (`catalogue_key = null`, `review_reason: 'no-catalogue-match'`, contributes **0 ft³** until the estimator maps it).
- Volume fields anywhere in output → discarded (schema has none; any smuggled numbers in strings are ignored — volume only ever comes from `catalogueItem(key).ft3`).
- `qty` clamped to 1–50 (a detection wanting more is suspicious → review exception).
- Timestamps clamped to `[0, duration_s]`.
- Top candidate ≥0.8 confidence AND qty ≤5 AND moving ≠ uncertain → auto-acceptable (no `review_reason`, included in bulk room-accept). Everything else gets a `review_reason`: `low-confidence` / `no-catalogue-match` / `uncertain-moving` / `high-qty` / `big-item` (any candidate ≥80 ft³ never auto-accepts — a wrong wardrobe costs a van).
- Malformed output (zod fail after one salvage attempt: strip unknown keys, coerce numerics) → run `failed`, normal retry path (fresh generation usually differs).

### 5.5 Deduplication (deterministic, no model calls)

- **Within room, across clips/runs:** same `catalogue_key` + same room from different media → merge into one detection with `qty = max(quantities)` (not sum — re-filming shows the same items), `review_reason: 'seen-in-multiple-clips'` if quantities disagreed.
- **Across rooms:** never auto-merged (two wardrobes in two bedrooms is reality, not duplication).
- **Against existing manual lines:** if canonical `items` already has the same `catalogue_key` with `room` equal to this room's name, the confirm-merge step flags it ("Bedroom 2 already has Wardrobe ×1 — add anyway / increase qty / skip") rather than silently double-adding.

### 5.6 Contingency (deterministic, explainable — `lib/ai/contingency.ts`, pure + tested)

- **10%** — every room `confirmed`, all coverage `good`, no unresolved detections, hidden-storage checked in every room.
- **20%** — all rooms confirmed but any: coverage `partial`, whole-property import used, hidden storage unchecked somewhere, or >10% of detections were manually corrected.
- **30%** — any coverage `poor` that was still accepted, or heavy clutter warnings — all exceptions must still be resolved.
- **No van recommendation (fail closed)** — any declared room not confirmed, or any unresolved unmatched/big-item exception.

Written to `cubic_surveys.contingency_pct` at confirm time; recomputed on every subsequent confirm. **Planning volume = `total_ft3 × (1 + contingency_pct/100)`** feeds `recommendVans()` on the quote page, Step-3 hint, and the survey card (display: "Raw 850 ft³ · Planning 935 ft³ (+10%)"). Manual-only surveys keep `contingency_pct = 0` — identical behaviour to today. The crew/job-sheet volume line keeps showing **raw** (what's physically loaded), unchanged. Note: `cubicFillPct` (90%) already discounts van capacity for loading efficiency — that is a *van-side* margin and stacks intentionally with the *inventory-side* contingency; the two answer different questions and both being visible is a feature (iMVE hides both).

### 5.7 Confirm-merge (the only path into canonical items)

`confirmAiItemsAction(surveyId, roomId, baseUpdatedAt)`:
1. Load detections for the room in state `accepted`/`edited` (bulk room-accept first promotes all no-`review_reason` `proposed` rows).
2. Build `CubicLine[]`: `key = catalogue_key` (or `custom:<uuid>` + estimator-supplied `unitFt3` for mapped-to-custom items), `qty`, `flags` from resolution, `room = room.name`, `source = 'ai'`, `note = narrationNote`.
3. Run the §5.5 against-manual check; apply the estimator's choices.
4. Merge into `items` through the same optimistic-concurrency UPDATE shape as `saveCubicSurveyAction` (`.eq("updated_at", baseUpdatedAt)`; conflict → the existing reload banner, nothing written).
5. Mark merged detections `merged`, room `confirmed`, recompute `contingency_pct`, insert an `activities` row ("AI survey: Bedroom 2 confirmed — 14 items, 212 ft³"), `revalidatePath` the lead + quote pages.

Idempotent by construction: `merged` detections are excluded from any later merge; re-running with a stale token writes nothing.

---

## 6. Screens & UX (tablet-first: 44px targets, 16px inputs, no hover-only anything)

The estimator's mental model: **"Record each room → it lists what it saw → I fix the few it flags → done."** Three screens, all hanging off the existing builder route. No new sidebar entries.

### 6.1 Entry — the existing builder (`/leads/[id]/cubic`)

When `ai_survey_enabled`:
- Header gains two buttons: **"AI room scan"** (primary, camera icon) and **"Import video"** (secondary). Manual search-first builder below is byte-for-byte unchanged.
- Once rooms exist, a **Rooms strip** renders between header and builder: one chip per room — name + status ("Recording", "Uploading 64%", "Analysing…", "**Ready to review · 14 items**", "Confirmed ✓ 212 ft³", "Failed — retry"). Tap a `ready` chip → review workspace. `+ Room` chip at the end.
- Lines merged from AI show a small "AI" badge and carry their room label; a **"Group by room"** toggle appears on the line list when any line has a `room` (default stays the current category grouping — zero change for manual-only users).
- First AI action per survey opens the **consent sheet** (§9) — four checkboxes, stored to `cubic_surveys.ai_consent`, never asked again for that survey.

### 6.2 Capture — `/leads/[id]/cubic/scan` (one route: record → review clip → upload, so the camera stream never crosses a navigation)

- **Room picker sheet** (on entry and after each room): existing rooms with status, or "New room" — name field pre-suggested from presets (Living room, Kitchen, Bedroom N auto-increments, Garage, Loft, Shed…), optional floor. One toggle: "Wardrobes/cupboards opened on camera or narrated?" (feeds hidden-storage + contingency).
- **Camera view:** full-screen rear camera, big red record button, timer with 2:00 cap (amber at 1:45), mute toggle (audio ON by default — narration is a first-class input: *"the piano stays"*, *"two boxes in this wardrobe"*), static coverage hints ("pan slowly · open wardrobes · narrate what stays"). **No fake live detections** — a subtle Marley-red scan-line animation communicates "recording for analysis", honestly.
- **On stop:** inline replay + **Use clip** / **Retake**. "Use clip" → frame extraction (~2 s, progress ring) → TUS upload with real progress + pause/resume; upload continues while the estimator moves to the next room (uploads are per-room and independent). Leaving with unsent media → confirm dialog (house `sheet-dismiss-confirm` pattern).
- Failure honesty: upload failed → chip shows "Upload failed — tap to resume" (tus resumes from the last 6 MB chunk, even after tab close).

### 6.3 Import — dialog on the builder

File picker (mp4/mov/webm, ≤500 MB) → assign to: existing room / new room / **"Whole property"** → TUS upload. Whole-property media analyse with the segmentation prompt; detections arrive grouped under **proposed rooms** which the estimator renames/merges/confirms in review (unassigned proposals block survey confirmation — fail closed). Photos import the same way (photo jobs send images instead of video parts — same schema, same review).

### 6.4 Review — `/leads/[id]/cubic/review?room=<id>`

Two-pane on tablet landscape (stacked portrait):
- **Left: player.** Signed-URL video; tapping any detection seeks to its first timestamp (nearest extracted frame as poster for instant paint). If `ai_grounded_replay_enabled` (default OFF): evidence frames render stored bounding boxes; otherwise a timestamp callout only — never a fabricated box.
- **Right: tabs.**
  - **Needs attention (n)** — only detections with a `review_reason`, worst first. Card: label → matched item + ft³ (from catalogue), candidate picker (the ≤3 candidates + catalogue search + "custom item"), qty stepper, Moving/Staying toggle, dismantle/fragile chips, reason line ("Low confidence" / "No catalogue match" / "'staying' heard at 01:12"). Buttons: **Accept / Reject**. 44px everything.
  - **By room** — every detection grouped; high-confidence ones pre-ticked; **"Accept room (12)"** bulk button per room.
  - **All items** — flat list with search.
- **Sticky bottom bar:** `Raw 850 ft³ · +10% contingency · Planning 935 ft³ · 2 Lutons` (updates live as detections resolve) + **"Confirm room"** → merge (§5.7) → next unconfirmed room, or back to the builder when none remain. Unresolved exceptions in the room → button disabled with count ("Resolve 3 items first") — the fail-closed gate made visible.

### 6.5 Progress & freshness

No websockets. The builder/review pages poll a light `getAiSurveyStateAction(surveyId)` every 5 s **only while** any room is `processing` (typical clip: analysis lands in 20–60 s). Processing stages shown are real states from the DB, not theatre: Uploading → Queued → Analysing → Ready.

### 6.6 Settings → new "AI Survey" card (`is_office`)

Enable switch (kill switch), model default + escalation (text inputs), per-survey & monthly caps (£), this-month spend + last-6-months mini-table (from `ai_spend_months` + run ledger), failed/dead jobs count with retry buttons, retention stats (media count/GB live, next sweep), vps1 storage disk note. Integration health page gains an **AI (Gemini)** row: models-endpoint ping + month spend + dead-job count.

### 6.7 Explicitly unchanged

Manual builder mechanics · `/cv/[token]` customer survey (V2 only) · quote Step-3 hint & survey card *except* they now use planning volume with the contingency shown · crew job page + job-sheet PDF volume line (raw, price-free) · van pre-select on new drafts (planning volume) · `survey-photos` pipeline.

---

## 7. Server surface (exact names)

**`app/actions/ai-survey.ts`** — all behind `requireActiveProfile()`, writes via `createAdminClient()`, every mutation inserts an `activities` row where user-meaningful, all return the house `{ ok: true, … } | { ok: false, error }` shape:

| Action | Signature (input → ok payload) | Notes |
|---|---|---|
| `saveAiConsentAction` | `(surveyId, acks: string[])` → `{}` | writes `ai_consent` once |
| `createRoomAction` | `(surveyId, { name, roomType?, floor?, hiddenStorageChecked })` → `{ roomId }` | |
| `updateRoomAction` | `(roomId, patch)` → `{}` | rename / hidden-storage / sort |
| `deleteRoomAction` | `(roomId)` → `{}` | blocked if room has `merged` detections |
| `registerMediaAction` | `(surveyId, { roomId?, kind, mime, bytes, durationS? })` → `{ mediaId, storagePath }` | validates caps (§5.1) + mime allow-list; path is server-generated |
| `finalizeMediaUploadAction` | `(mediaId, { frames: {t,path}[] })` → `{}` | verifies object exists (admin `list`), validates frame paths against the media's folder, media → `uploaded`, enqueues `process_media`, **kicks the drainer** via `after(() => fetch(APP_URL + '/api/cron/ai-jobs', { headers: { Authorization: Bearer SYNC_CRON_SECRET } }))` — fire-and-forget; the cron is the safety net |
| `resolveDetectionAction` | `(detectionId, { state: 'accepted'\|'edited'\|'rejected', resolution? })` → `{}` | `edited` requires resolution |
| `acceptRoomDetectionsAction` | `(roomId)` → `{ accepted: n }` | promotes all no-reason `proposed` |
| `confirmAiItemsAction` | `(surveyId, roomId, baseUpdatedAt, conflicts?: {detectionId, choice}[])` → `{ totalFt3, contingencyPct, updatedAt } \| { conflict: true } \| { needsChoices: […] }` | §5.7 |
| `retryAiJobAction` | `(jobId)` → `{}` | `failed`/`dead` → `queued`, attempts reset |
| `getAiSurveyStateAction` | `(surveyId)` → rooms + media statuses + counts | the 5 s poll; read-only |

**Routes:**
- `app/api/cron/ai-jobs/route.ts` — `export const maxDuration = 800`; auth `requireUserOrCronSecret(req)` (house helper — Vercel cron, SYNC_CRON_SECRET kick, or a signed-in office user hitting it in the browser); claims ≤3 jobs via `claim_ai_jobs`, processes sequentially, returns `{ claimed, done, failed }`.
- `app/api/cron/ai-retention/route.ts` — daily (§9).
- `vercel.json` — add `{"path": "/api/cron/ai-jobs", "schedule": "*/2 * * * *"}` and `{"path": "/api/cron/ai-retention", "schedule": "30 2 * * *"}`. The 2-min sweep is retry latency only; the kick gives ~instant starts.

**`lib/ai/`** (new — the repo's first LLM code, keep it exemplary):
`gemini.ts` (AI SDK provider from `GEMINI_API_KEY`, model ids from settings) · `files.ts` (Supabase→Files-API streaming, whole/chunked + ACTIVE poll) · `prompts.ts` (`PROMPT_VERSION`, itemise + segmentation prompts, catalogue allow-list block) · `survey-schema.ts` (zod contracts) · `validate.ts` (§5.4, pure) · `dedup.ts` (§5.5, pure) · `contingency.ts` (§5.6, pure) · `merge.ts` (detections→CubicLine[], pure) · `budget.ts` (estimates, GBP↔USD, reservation calls) · `jobs.ts` (drainer step logic; thin I/O shell around the pure parts).

**Env:** `GEMINI_API_KEY` (server-only; `.env.local` + both Vercel envs from `credentials.env` — never `NEXT_PUBLIC_`).

---

## 8. Spend controls

Real cost is ~$0.06/survey (default model) to ~$0.35 (all-escalated) — the caps are **circuit breakers against bugs and abuse**, not budget management:

- Per-survey cap £2 (`ai_survey_cap_gbp`) — checked before every model call against the survey's run ledger. Trip → room "AI paused (survey cap)"; manual always available.
- Monthly cap £50 (`ai_monthly_cap_gbp`) — atomic `reserve_ai_spend()`; alert at £40 via `sendOpsAlert` (once per month — guard with a `spent≥alert && (spent−actual)<alert` crossing check, no idempotency table needed).
- Every run records model, tokens, actual USD; ledger reconciles estimate→actual after each call.
- Retries, escalation and segmentation all draw from the same reservations — nothing is exempt.
- Kill switch: `ai_survey_enabled = false` hides all AI UI and makes the drainer park jobs untouched (checked at claim time).
- Gemini side: key is on paid Tier 1 (Phase 0 confirms billing); Tier-1 $10-per-10-min rolling spend cap is 2 orders of magnitude above our worst case — irrelevant but noted.

## 9. Privacy, consent, retention (UK GDPR)

- **Consent sheet** before first capture per survey (stored `ai_consent`): customer consents to filming + AI processing · audio explained (mute available) · avoid paperwork/photos/people where practical · manual survey offered as alternative. Estimator confirms on the customer's behalf in person — V1 is estimator-operated by design.
- **Processor chain:** footage → Supabase (RBS-controlled, vps1, Germany) → Google Gemini API (paid tier: no training on prompts; UK/EEA no-training treatment contractually; **no residency commitment** — if a future client contract demands EU-resident inference, that's the Vertex AI migration, out of V1 scope). Gemini Files API copies auto-delete at 48 h; we do not rely on that — retention is ours.
- **DPIA:** complete a short UK GDPR DPIA before field rollout (Phase 6 gate). Privacy-policy line for Marley's site noting AI-assisted video surveys + retention period → flag to Peter at Phase 6 (site change, separate repo).
- **Retention cron** (daily 02:30): delete `survey-media` objects + rows for surveys whose **lead** hit terminal status (`completed`/`declined`) >30 days ago; drafts untouched >90 days; `legal_hold = true` skips + logs. Deletes via **Storage API admin client** (never SQL — house lesson). Detections/runs/rooms rows are kept (they're the audit trail; tiny); only media + frames are purged. Failures alert ops; the Settings card shows live media GB so the 36 GB vps1 headroom is visible, not hoped-for.
- **Dedicated-VPS triggers** (Peter has offered an 8 GB box — deliberately deferred): live media >25 GB sustained, or server-side transcode need (odd-codec imports become common). Either trips → move the storage volume / add the box as a media worker. Not V1.

## 10. Feature flags & rollout

Settings-driven (no deploys to toggle): `ai_survey_enabled` (master, default **false**) · `ai_grounded_replay_enabled` (V1 ships OFF; enable after real-footage frame-alignment checks) · customer AI capture has **no flag** — it does not exist until V2.

Rollout: (1) internal — Peter's own test leads (07572382366 / peter@abacusonline.net contacts only); (2) shadow — Connor/Luke record real surveys AND keep their manual count; we compare, nothing customer-visible changes; (3) gates from §1 hold over 30 field surveys → AI-first becomes the default working style. Rollback at any point = flip `ai_survey_enabled` off; manual survey is untouched throughout; confirmed inventory is never deleted by anything.

**V2 (explicitly out of V1):** customer self-capture on `/cv` (hashed/expiring tokens, public TUS policies, abuse rate-limiting, consent UX, SMS/email notify), grounded-replay default-on, Vertex residency if contractually forced.

## 11. Implementation phases (each ends green: `npx tsc --noEmit` + `npm test` + `npm run build`)

**Phase 0 — Preflight (gates everything; ~half a day)**
1. Wire `GEMINI_API_KEY` into `.env.local` + Vercel (prod+dev); confirm billing tier in AI Studio.
2. **Spike** `scripts/ai-spike.mjs`: record 2 real room clips on an actual iPad → Files API upload → `Output.object(detectionSchema)` on both models → confirm: schema honoured with video input, timestamps sane, catalogue matching plausible, cost per run logged. **Fixtures from this spike become test fixtures.** If schema-with-video misbehaves → fall back to JSON-in-prompt + zod salvage (decision recorded in the PRD before Phase 1).
3. vps1 ops: `FILE_SIZE_LIMIT=524288000` + recreate storage container; verify with a >50 MB TUS upload from a browser session (session JWT, 6 MB chunks).
4. Worktree + feature branch off latest `master` (house worktree-first rule).

**Phase 1 — Domain & persistence:** migration 0031 (tables, RPCs, bucket, settings columns, survey columns); `CubicLine.room/source` + `sanitizeCubicLines`; pure engines TDD (`validate`, `dedup`, `contingency`, `merge`, `budget`) with spike fixtures.
**Phase 2 — Capture & upload:** `/scan` route (MediaRecorder + frames + tus), import dialog, consent sheet, rooms strip, `registerMedia`/`finalizeMedia` actions.
**Phase 3 — Pipeline:** `lib/ai/*` I/O halves, drainer + kick, escalation, spend reservation, run ledger, ops alerts.
**Phase 4 — Review & merge:** review workspace, exceptions flow, confirm-merge, planning volume through quote page / Step-3 hint / survey card.
**Phase 5 — Ops:** Settings AI card, integration-health row, retention cron, retry buttons, disk gauge.
**Phase 6 — Verification:** full test sweep; prod E2E at tablet viewport (house pattern: real flow end-to-end on prod with Peter's test contacts, then delete all test state); device matrix below; DPIA; shadow rollout starts.

**Deliberately NOT built (V1):** offline capture/background upload (interface warns before leaving with unsent media — that's it) · real-time on-device detection · mixed-fleet optimiser · LLM-based dedup/reconciliation (deterministic rules only) · separate office approval step (estimator confirmation + validation rules are the gate; office can edit the survey afterwards like any other).

## 12. Test plan

**Unit (house pattern — pure libs in `tests/lib/ai/`):** validate.test (unknown keys dropped, volume smuggling discarded, auto-accept boundaries incl. big-item ≥80 ft³, qty clamps) · dedup.test (max-not-sum, cross-room never merges, against-manual conflicts) · contingency.test (every band trigger + fail-closed states) · merge.test (CubicLine identity, room/source/note carry, idempotent re-merge excluded `merged`, custom-item path) · budget.test (estimates, GBP→USD, per-survey sum, month-boundary) · schema.test (spike fixtures parse; malformed fixtures fail then salvage where legal) · jobs.test (backoff schedule, stale-lock reclaim boundary, dead-at-max) · frames.test (timestamp→nearest-frame matching). Existing 200 tests untouched and green; `cubic-survey.test.ts` extended for the new optional fields.

**E2E (prod, tablet viewport, test data only, then cleaned):**
1. Record 3 rooms with narration ("sofa stays") → analysed → "stays" item arrives `moving: staying`.
2. Kill the network mid-upload → resume from chunk → completes.
3. Close the tab during analysis → return → room `ready` with detections.
4. Resolve exceptions incl. one unmatched → custom item; confirm room → lines in builder with AI badge + room label; quote Step-3 shows planning-volume van rec.
5. Bulk "Accept room"; verify big-item was NOT bulk-accepted.
6. Whole-property import → segmentation proposals → rename/merge → confirm.
7. Record the same room twice → single merged detections, qty = max.
8. Two tabs: confirm in A, then confirm in B with stale token → conflict banner, no double lines.
9. Poor footage (dark 10 s clip) → warnings → fail-closed (no van rec) until resolved.
10. Trip the per-survey cap (temporarily set to £0.01) → "AI paused", manual unaffected; reset.
11. Kill switch off mid-queue → drainer parks jobs; on → resumes.
12. Retention dry-run against a synthetic old survey.

**Device matrix (manual):** iPad Safari (the real estimator device) · iPhone Safari · Android Chrome · portrait+landscape · camera/mic permission denied · muted recording · backgrounding mid-record (clip up to that point survives via `dataavailable` fallback).

## 13. House conventions the implementer MUST follow (from the live codebase)

- Server actions: `requireActiveProfile()` gate → zod-parse input → mutate via `createAdminClient()` → return `{ ok: true, … } | { ok: false, error }`. Never trust client-computed totals/paths — recompute/validate server-side (see `saveCubicSurveyAction`).
- Optimistic concurrency: `.eq("updated_at", baseUpdatedAt)` + `.select().maybeSingle()`; empty result = conflict, surface the reload banner.
- RLS: new tables get `is_staff()` r/w + `is_admin()` delete; SECURITY DEFINER RPCs revoked from anon/authenticated. Settings behind `is_office()`.
- Storage: browser uploads direct (anon client + RLS); server validates reported paths against the record's folder; storage deletes via admin Storage API, never SQL; display via `createSignedUrl(path, 3600)`.
- Migrations: numbered `00NN_name.sql`, applied to prod via psql-over-SSH + `notify pgrst, 'reload schema'`.
- UI: Marley tokens (`mm-red` accents, one per surface), `INPUT_H = h-11`, 44 px touch targets, 16 px inputs, `focus-ring`, pills/chips per existing status badges; user-meaningful mutations insert `activities` rows; `revalidatePath` the affected lead/quote pages.
- Timestamps in user-facing UK copy; no em-dashes in customer-facing strings; UK English.
- Commits: small, per-phase, `--author="Peter Farrell <peter@redbananastudios.com>"`; explicit-path staging only; deploy = push → Vercel API → verify prod sha; test on prod with Peter's own contacts only (07572382366 / peter@abacusonline.net), never real customers, and remove all test state after.

## 14. Verified references

Gemini: [pricing](https://ai.google.dev/gemini-api/docs/pricing) · [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) · [Files API](https://ai.google.dev/gemini-api/docs/files) · [file input methods (100 MB URL cap)](https://ai.google.dev/gemini-api/docs/file-input-methods) · [structured output](https://ai.google.dev/gemini-api/docs/structured-output) · [terms (UK no-training)](https://ai.google.dev/gemini-api/terms). Libraries: [tus-js-client](https://github.com/tus/tus-js-client) · [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) · [Mediabunny](https://github.com/Vanilagy/mediabunny) · [AI SDK v7](https://vercel.com/blog/ai-sdk-7) · [v6→7 migration (generateObject deprecation)](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0). Vercel: [function limits](https://vercel.com/docs/functions/limitations) · [maxDuration](https://vercel.com/docs/functions/configuring-functions/duration) · [cron](https://vercel.com/docs/cron-jobs/usage-and-pricing). Prior art (pattern reference only): [Yembo visual inventory UX](https://yembo.ai/moving/visual-inventory) · [AI-Moving-Cost-Estimator](https://github.com/Nazmul0005/AI-Moving-Cost-Estimator). VPS facts: recon 2026-07-11 (storage-api v1.60.4, TUS 204 public+internal, FILE_SIZE_LIMIT 50 MiB, 36 GB free).
