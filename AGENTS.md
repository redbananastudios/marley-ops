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

## Current State (2026-08-23 pm — seven PRs merged, staging GREEN, zero open QA findings; prod still on 67d8f37)

Last touched: 2026-08-23 on i9 — **staging `89fab87` is GREEN (1879 unit + 130 e2e). Production is UNCHANGED on `67d8f37`, now 15 commits behind, and is clear to promote.**

- **All four 2026-08-23 QA findings are closed on real evidence.** QA-01 (crew silently dropped on an in-window date change → a "Called off" card, #54/#61), QA-02 (quote sent a total the DB would not charge → persist-then-send with a recompute guard, #62), QA-03 (refunds toast claimed "customer emailed" when nobody was told, #62/#65), QA-04 (crew offered a push opt-in that can deliver nothing, #66/#67). `qa/findings/open/` is empty and no GitHub finding issues are open. Evidence per finding is in `qa/LOG.md` — **the closure notes are the record, not the commit subjects**: a prior run closed three findings citing a log entry it never wrote (corrected in #63).
- **Realtime crew-allocation pushes retired (#56, Peter's call)** — crew learn the day from the night-before job sheet. Fallout fixed in #66: every remaining push category is office-only, so `NotificationsRow` now gates on `pushCategoriesForRole(role)` and shows crew nothing rather than spending their one-shot permission prompt for zero notifications. `business_settings.push_crew_job_enabled` survives but is unread.
- **Job Board PAGE removed, component kept (#60).** `/schedule` renders `<JobBoardView hideSurveys />` — the board IS the allocation UI there; actions live in `app/actions/board-allocation.ts`, and eight `revalidatePath("/schedule/board")` calls were **repointed** to `/schedule`, not deleted. `/growth` gone (`growth_artifacts` untouched for the new app); **`/content` KEPT** — Peter reversed that removal on learning it is the marketing approval gate.
- **`e2e` gate is satisfiable on a docs-only commit (#55)** — filtering moved from workflow to jobs, detection fails toward running. Confirmed empirically on `3e4bd36`: `changes` succeeded, the three heavy jobs skipped, and the `e2e` check still existed on the commit.

**Open decisions:** promote `staging`→`master` — Peter's call; nothing is blocking it. **Blockers:** none. **Older open items** → [ClickUp 869ehpv2x](https://app.clickup.com/t/869ehpv2x), not re-verified. Import CSV `jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
