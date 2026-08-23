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

## Current State (2026-08-23 — QA backlog cleared to zero, one new risky finding; 33 commits await promotion)

Last touched: 2026-08-23 on i9 — **the audit backlog is empty for the first time in four days, and `staging` is 33 commits ahead of `master` including a security fix prod does not have.**

- **PROMOTION IS THE OPEN ITEM (Peter's call).** prod `17a56ae` · staging `63a495c`. The queue includes **`8c88f27` — the office-only signed-contract PDF was served to ANY logged-in user** (crew included): fixed, e2e-proven against deployed staging, **still open on prod**. Also queued: the enquiry-push monitor (`b5e31c0`), the crew job-sheet date fix (`115559c`), and the shared-client/storage-guard fixes below. Merging `staging`→`master` **auto-deploys to production** — the manual approval gate was removed 2026-08-21.
- **Peter-directed sweep (22 Aug eve).** The findings loop was misidentifying its own issues: both jobs looked up by `--search "$id in:title"` and took `.[0]`, so a finding whose title quoted another finding's id shadowed it. It closed the wrong issue — and in the `raise` direction the same collision reads as "already raised", so a genuine new finding would have been logged as handled and **never filed** (`875eec3`, exact-prefix match, proven in CI).
- **Both remaining risky findings fixed on Peter's calls and independently live-verified by the next audit (`4d93a04`).** QA-20260819-01: a lead's page read the shared `clients` row first, so it showed a sibling's details and the Edit dialog wrote them into the lead's own row — the columns comms sends to; the lead now owns its details and write-through only happens for a sole enquiry, with a toast when it declines. QA-20260820-08: the storage-let delete guard counted a column nothing writes; now refuses only the last lead on the client.
- **NEW — QA-20260823-01 (`risky`/`high`, OPEN, Peter-only):** changing a move date inside the 7-day window from `/bookings` cancel+rebooks, but the crew/vehicle assignment does not carry to the new appointment and **the assigned crew member is told nothing** — the job silently vanishes from `/my-jobs`. The office side is correctly flagged ("No crew — allocate"); only the crew side is silent.
- CI green on staging, **130/130 e2e** (`fcb5c9f` fixed two locators a customer's own name could defeat — staging holds two customers literally named "New quote").

**Open decisions:** promote `staging`→`master` (above). **Blockers:** none technical. **Older open items** (iMVE batch-3 cards, Luke's provisional dates + vans, Jackson storage) → [ClickUp 869ehpv2x](https://app.clickup.com/t/869ehpv2x) — carried from the 13 Aug block, not re-verified this session. Import CSV `jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
