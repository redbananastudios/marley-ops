# Crew Content Capture v2 — area/location content for GBP + local SEO

**Status: DESIGN APPROVED (Peter, 2026-07-28) — BUILD PARKED** until after the
takepayments go-live work. Extends the shipped capture system (v1:
`docs/job-content-capture-prd.md`, migration 0050) — Approach A: one crew
surface, one approval queue, marketing content separated from job evidence at
the STORAGE layer, not by a second tool.

**Peter's locked calls (2026-07-28):**
- Peter approves all content (the `/content` queue owner).
- Auto-drafting posts from captures: NOT in scope — to be discussed.
- Crew nudging/prompting: NOT in scope — Peter discusses with crew first.
- Both capture paths: area toggle inside job capture AND standalone area
  capture from the crew home screen.
- Drive folders named **"Town OUTCODE"** — `Gillingham SP8`, `Templecombe BA8`,
  `Shaftesbury SP7`.
- Crew are NOT technical — one-thumb, zero typing, zero filing is a hard
  requirement everywhere.

**Research basis (local-seo requirements check, 2026-07-28 — full report in
the session; key verdicts baked in):**
- Town-name is the primary content key; outcode is secondary metadata. All
  consumption surfaces (GBP post copy, `/removals/[town]/` pages, search
  queries) are town-phrased.
- NO EXIF geotag publishing — Google strips it and the only rigorous study
  showed it *hurting* "service + town" queries. GPS is captured internally
  only, to auto-suggest the town so crew never type.
- Value = authenticity + per-town uniqueness. The same photo must never appear
  on two town pages. GBP: photos ≤5MB (720px+), video ≤30s/≤75MB (also the
  Reels sweet spot). No filters ("represents reality" policy).
- Shot list (ranked): van-by-landmark town hero · crew at work (street
  context) · load "Tetris"/before-after · team by the van · access-challenge
  shots (prove the "tricky parking" claims the town pages make) · ≤30s
  vertical video · storage yard · street scenes · handover (explicit consent
  only) · seasonal.
- UK photography cautions → capture-time flags, not a policy PDF: bystanders
  framed out or "needs blur"; children never identifiable; third-party number
  plates blurred (our own vans fine); never house-number + interior pairings;
  captions/filenames follow the address-display rule ("Shaftesbury, SP7"
  style, never full addresses, never imply premises we don't have).

## 1. Crew UX (the only part crew ever see)

- **Capture sheet gains one mode**: Photo · Video · Voice · **Note** (typed —
  big text box, save; for "the new estate off X has terrible access" thoughts).
- **Context pill** at the top of the sheet when opened from a job:
  **[This job] / [Area]** — default This job. Area selected → a **town chip**
  appears, pre-filled from the job's move address (postcode → town lookup);
  tapping it opens a one-tap 16-town list (+ Other). No free typing.
- **Standalone entry**: a "Capture" button on the crew home (`/my-jobs`) opens
  the same sheet locked to Area context; town auto-suggested from phone GPS
  (offline nearest-centroid over the 16 towns — no geocoding API), one tap to
  confirm or change.
- **Shot-type chips** (optional — NEVER blocks saving; zero-filing rule):
  Area → Van in town / Street / Landmark / Access. Job → Before / After /
  Loading / Team / Story. One tap, skippable.
- **"Needs blur" toggle** + a single reminder line in Area mode ("Public
  places only — no close faces, no house numbers"). Everything else is
  publish-time discipline, not crew burden.
- Job-consent flow (v1) unchanged.

## 2. Data model (one migration)

- `job_media.lead_id` → nullable, with `check (lead_id is not null or
  town_slug is not null)` — every row anchors to a job or an area.
- New columns: `context text not null default 'job' check (context in
  ('job','area'))`, `town_slug text` (canonical 16 + 'other'), `outcode text`,
  `lat numeric` / `lng numeric` (internal only), `needs_blur boolean not null
  default false`.
- `kind` check gains `'text'` (Note body lives in `caption`; transcript
  machinery untouched).
- `tag` check extended with the area shot types (`van_in_town`, `street`,
  `landmark`; `access` already exists).
- Area rows have no customer → `consent_state` stays 'unset'; the approval
  gate (a human looking at the image) is the check. The v1 invariant
  (internal_only never approvable) unchanged.
- RLS: mirror v1 policies exactly (staff insert own via `created_by =
  auth.uid()` pattern from 0076's events fix; office read/approve).

## 3. Review queue (`/content`)

- Filters gain **Town** and **Context (Job / Area)**.
- Area cards show the town chip + needs-blur flag; approval requires a town.
- Approval semantics unchanged — Peter approves; nothing publishes without it.

## 4. Publishing sync (the NEW half — i9-owned, VPS never holds Drive creds)

Nightly i9 scheduled task (silent VBS-launcher per house rule):
1. PostgREST: approved + unsynced rows (`marketing_approved_at not null and
   synced_at is null` — the 0050 index exists).
2. Download via signed URLs (media-store seam, R2).
3. Write to the Drive hub:
   - Area → `08 Media Library/real/areas/<Town OUTCODE>/`
   - Job content → `08 Media Library/real/jobs/<Town OUTCODE>/` (town derived
     from the lead's move address; `unsorted/` fallback).
   > **Path note (2026-08-17):** `real/jobs/` and `real/crew/` were flattened
   > into a single flat `photos/` folder (`<subject>_<view>_<context>_<date>`,
   > see `08 Media Library/README.md`). Target `photos/` with that convention
   > when building this, and keep any per-town grouping in the filename
   > (`job_loading_gillingham-...`) rather than re-creating subfolders.
4. Per file: **strip EXIF**, descriptive filename
   (`removals-<town>-<shot>-<yyyymmdd>-<id6>.<ext>`), sidecar `.json`
   (caption, transcript, tag, consent state, needs_blur, source ids) so the
   social agents and copywriters get context without DB access.
5. Stamp `synced_at` via PostgREST. Fail-soft per file; summary logged; the
   social agents' real-photo class already reads the hub via brand.md
   `media_library()` — zero agent code changes.

## 5. Explicitly out of scope (parked with reasons)

- Auto-drafting posts from captures (Peter: discuss first).
- Crew nudges/job-sheet prompts (Peter talking to crew first).
- Contractor-agreement crew media consent line (rides the existing agreement
  v2 accountant/solicitor review).
- GBP auto-posting changes (browser-pass pipeline unchanged; it just gains
  better raw material).
- Website town-page image wiring (agents/manual selection for now; unique-
  per-town-page rule enforced editorially until then).

## 6. Implementation plan (milestones — each gated lint+tsc+vitest+build)

- **M1 — schema + server**: migration (§2, applied dev+prod before push, types
  regen); capture-context action gains area path; pure `nearestTown(lat,lng)`
  + `postcodeToTown(outcode)` utils over the 16 canonical towns (TDD — these
  are the logic core); job_media action validation (town required when
  context='area').
- **M2 — capture sheet v2**: Note mode; context pill + town chip + GPS
  suggest; shot chips; needs-blur toggle; standalone entry on `/my-jobs`.
  Browser-verify at phone viewport as crew.
- **M3 — review queue**: town/context filters, area cards, approval guard.
- **M4 — i9 sync**: script (RBS-OS `scripts/marley-media-sync.ps1` or python
  beside the agents), EXIF strip + filename + sidecar, scheduled task via
  VBS-launcher + `make-tasks-silent.ps1`, folder bootstrap for the 16 towns.
- **M5 — verify + docs**: e2e (crew capture area item → approve → sync dry-run
  lands in the right folder), 2-lens review (correctness + RLS per house
  rule), CLAUDE.md/PRD alignment.

Estimate: M1–M3 one focused session; M4–M5 a half each. No dependency on the
takepayments work — resumable any time from this doc.
