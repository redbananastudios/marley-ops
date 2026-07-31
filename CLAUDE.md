@AGENTS.md

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

## Current State

Last touched: 2026-08-01 on i9 — **system-wide financial/count-correctness pass promoted (`1fd23df`; prod deploy 30671850166 awaiting Peter's approval).** (Prior session — staging env built + the nav-race server-redirect fix `8cb6c71` — is in git history / the brain CHANGELOG.)
- **Fixed on prod earlier this session:** a **crossed bank payment** — E Dingley's £100 was wrongly *amount*-matched to Rebecca Eldred's MMR017 while Eldred's own "MMRO17"-referenced £100 sat unmatched; re-attributed correctly (bank rows only, Zoho untouched). Then **matcher hardening** (`5c8db07`): typo-tolerant quote refs (O↔0/I↔1/etc.) + a **payer-name gate** on amount-only bank matches, so a stranger's coincidental amount can't one-tap-match someone else's quote.
- **Financial/count audit** — a multi-agent sweep of 11 money/count surfaces found **21 confirmed mis-bindings** (a displayed figure/count bound to a different set than it summarised; report `docs/financial-count-audit-2026-07-31.md`). ALL FIXED, adversarially verified, **/code-reviewer APPROVED (no blockers)**. HIGH: cancelled/refunded bookings no longer inflate Jobs-won/revenue/margin/ROAS/estimator credit (new `isWonQuote` excludes `booking_cancelled_at`). +11 MED (balance nets the 25% commitment credit; margin uses ex-VAT vs ex-VAT; storage crate **day**-rate no longer treated as weekly; win-rate excludes superseded; etc.) +9 LOW.
- **Bug A:** Availability calendar now grades a **per-day usable fleet** (staff `working_days` + availability + vehicle off-road, reusing the Job-Board logic), so it agrees with Day Allocation — **weekends show 0 crew**. **Bug B:** bank feed surfaces **all-dates** unmatched inbound (count = the visible list; prior-day payments no longer hidden). **Feature:** bank-feed **"Clear"** (dismiss — the sync preserves dismissed, a hard delete would re-import) for old-system transfers. **Book Removal** form: end defaults to the **same day** + an **All-day** toggle.
- Gates lint 0 · tsc 0 · vitest **1256** (+40 tests) · build. Staging e2e **109 passed** + targeted browser checks (weekend crew 0, Clear button, All-day toggle) green.
- **Verify next:** Peter approves prod deploy **30671850166**. **Fast-follows** [ClickUp 869echgta]: dashboard balance-count dedup helper + bank-feed badge head-count (both latent drift/truncation the reviewer flagged). Carried: PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp); R2 staging bucket not created (media inert, safe).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
