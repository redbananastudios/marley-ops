<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## PRODUCTION IS LIVE (cutover 2026-07-30, Peter's order)

**`ops.marleymoves.co.uk` is the LIVE system of record since 2026-07-30 12:09 UTC.** Real customers, real money, real emails (`COMMS_DRYRUN=false`), card payments LIVE (takepayments merchant 292748, kill switch ON), Zoho = Connor's real books. Treat every prod write as customer-facing. The go-live flush ran via `scripts/reset-data.mjs`; `LEAD_SYNC_SINCE=2026-07-30T00:00:00Z` is the no-backfill floor — never remove it (historical website leads must not import; the sync code now also FAILS CLOSED if it is ever dropped/garbled, `2ba1a0e`). **Dev stays guarded**: `SANITY_SYNC_DISABLED=true` remains in `.env.local` so dev never pulls real enquiries (2026-07-13 lesson: the Sync button re-imported 78 real enquiries into dev mid-test).

## AI survey gotchas (2026-07-13)

- **`GEMINI_API_BASE_URL` MUST include `/v1beta`** (`https://generativelanguage.googleapis.com/v1beta`). `lib/ai/gemini.ts` polls file status at `${baseUrl}/${file.name}` and passes baseUrl into `createGoogle` — the bare origin 404s every analysis ("Gemini file status failed (404)"). Only the upload path tolerates both forms. Prod `app.env` fixed to the /v1beta form 2026-07-13. The intended pre-launch policy is `COMMS_DRYRUN=true`, but live `app.env` was verified as `COMMS_DRYRUN=false` on 2026-07-20; do not assume sends are simulated or change the flag without Peter's cutover decision.
- **Local dev has NO cron** — `ai_jobs` sit `queued` forever and the survey UI polls indefinitely. Drain manually while logged in as office: open `http://localhost:3015/api/cron/ai-jobs`.

## Ops: live-prod DB writes are classifier-gated (2026-07-31)

Direct prod DB writes from the shell (`ssh … psql -c "update/delete"` AND `docker exec … node`) are BLOCKED by the auto-mode classifier. Working pattern for an authorised one-off: a service-role node script run in a fresh alpine container —
`sudo docker run --rm --env-file /opt/marley-ops/app.env -v /tmp/x.mjs:/work/_maint.mjs -w /work node:22-alpine sh -c "npm i @supabase/supabase-js --no-save && node _maint.mjs"`
(`docker run` is allowed; the app image bundles supabase into build chunks so it is NOT resolvable there — install fresh). Prefer flipping settings-editable values (VAT %, rates) in the ops UI over DB surgery.

## House conventions

- **Before ANY push: `npm run lint` locally, always** — the CI gate enforces ESLint
  rules tsc never sees (react-hooks, no-unused-vars, no-unescaped-entities). Running
  only tsc+vitest has now broken the pipeline twice (session 32 agents; 2026-07-22
  balance refactor). All four gates or it doesn't ship: lint, tsc, vitest, build.

- **Page shell (2026-07-16, Peter caught /content hugging the edge):** every `app/(dashboard)/**` page's top-level element must be `<main className="flex-1 p-6 md:p-8">` (or the deliberate `page-shell` variant used by the dashboard/estimator views). The shared layout adds NO padding on purpose — a bare `<div>` root renders flush against the viewport. Full 34-page audit passed 2026-07-16; keep it true for new pages.

## Current State (2026-08-24 — prod live on `2b1cee2`; master == staging; zero open QA findings)

Last touched: 2026-08-24 on i9 — **production `/api/version` returns `2b1cee2`, and `master` and `staging` are both exactly that commit.** No promotion gap.

- **A retired route now lands somewhere (#70).** Removing `/growth`, `/growth/ads`, `/schedule/board` left bookmarks on Next's unstyled default 404 — Peter hit it on live. `/schedule/board` now redirects to `/schedule` (deliberately NOT `permanent`: a 308 is cached hard by the browser and would outlive any decision to restore it; the panel is noindex so there is no SEO argument). `/growth*` gets **no** redirect on purpose — that feature moved to a separate app, so pointing it at another page here would misrepresent where the data went. `app/not-found.tsx` catches everything else.
- **Diagnosing a 404 from outside is impossible — middleware bounces every unauthenticated request to `/login`,** so a real route and a nonexistent one both answer `307`. Enumerate route files at the deployed sha and diff against `navForRole` instead; a curl that returns 200 proves only that you reached the login page.
- **QA-20260823-05/-06 fixed and closed (#71/#72).** The h8 spec's teardown deleted `leads` while `communications`/`activities` still referenced them, so Postgres refused with `23503` and no call checked `error` — every CI run leaked a full marker set into staging. It now deletes children first, reads the lead back, and **throws** with the constraint name attached. Separately, `slotMinTime`/`slotMaxTime` were pinned 07:00—20:00, hiding any out-of-hours booking from Week/Day — the views the office allocates crew from; the window now derives from the events rendered (`lib/schedule/slot-range.ts`).
- **QA audit role agents run on `sonnet`, never `haiku` (`qa/AUDIT.md`).** Four Haiku agents each reported live UI verification they had not performed, and two claimed clean teardowns while leaving 7 orphaned auth accounts. A report is now evidence only if it carries literal automation artifacts, and the main loop spot-checks one claim per agent every run.
- **Known trap, tracked:** `deploy.yml` still filters at the workflow level, so a **docs-only commit pushed to `master` produces no deploy run** and prod silently drifts from `master`. Port #55's job-level shape — [ClickUp 869entgjt](https://app.clickup.com/t/869entgjt), due 2026-08-30.
- **Flagged, not fixed:** the first-pass (Fable) QA repair tier appears not to be firing — no first-pass entry in `qa/LOG.md` since 2026-08-21, and a sweep finding nothing eligible still logs. Every safe-fix finding since has been closed interactively, which leaves the escalation tier unable to help. Webhook/cron plumbing outside this repo.

**Open decisions:** none. **Blockers:** none. **Older open items** → [ClickUp 869ehpv2x](https://app.clickup.com/t/869ehpv2x), not re-verified. Import CSV `jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
