@AGENTS.md

## Data policy until go-live (Peter, 2026-07-13)

**Production `ops.marleymoves.co.uk` holds MOCK/TEST data only until Peter approves testing complete.** No live-lead backfill, no real customer records, keep `SANITY_SYNC_DISABLED` in place. The `growth_artifacts` rows are exempt (agent proposals + tracking summaries — no customer data). Do not flip anything to live data without his explicit approval. **Dev mirrors this**: `SANITY_SYNC_DISABLED=true` is set in `.env.local` too (2026-07-13 — the leads-page Sync button re-imported 78 real website enquiries into dev mid-test; wiped + guarded).

## AI survey gotchas (2026-07-13)

- **`GEMINI_API_BASE_URL` MUST include `/v1beta`** (`https://generativelanguage.googleapis.com/v1beta`). `lib/ai/gemini.ts` polls file status at `${baseUrl}/${file.name}` and passes baseUrl into `createGoogle` — the bare origin 404s every analysis ("Gemini file status failed (404)"). Only the upload path tolerates both forms. Prod `app.env` fixed to the /v1beta form 2026-07-13. The intended pre-launch policy is `COMMS_DRYRUN=true`, but live `app.env` was verified as `COMMS_DRYRUN=false` on 2026-07-20; do not assume sends are simulated or change the flag without Peter's cutover decision.
- **Local dev has NO cron** — `ai_jobs` sit `queued` forever and the survey UI polls indefinitely. Drain manually while logged in as office: open `http://localhost:3015/api/cron/ai-jobs`.

## House conventions

- **Before ANY push: `npm run lint` locally, always** — the CI gate enforces ESLint
  rules tsc never sees (react-hooks, no-unused-vars, no-unescaped-entities). Running
  only tsc+vitest has now broken the pipeline twice (session 32 agents; 2026-07-22
  balance refactor). All four gates or it doesn't ship: lint, tsc, vitest, build.

- **Page shell (2026-07-16, Peter caught /content hugging the edge):** every `app/(dashboard)/**` page's top-level element must be `<main className="flex-1 p-6 md:p-8">` (or the deliberate `page-shell` variant used by the dashboard/estimator views). The shared layout adds NO padding on purpose — a bare `<div>` root renders flush against the viewport. Full 34-page audit passed 2026-07-16; keep it true for new pages.

## Current State

Last touched: 2026-07-28 on i9 — **takepayments IP allowlist SET + refund path proven green end-to-end; friendly same-day-partial refund message.**
- **C7 IP allowlist DONE (Peter set it):** box IP `51.195.253.165` on the LIVE takepayments account (292748), i9 `51.179.200.95` on SANDBOX (292749), both in the **Direct Integration → Advanced + Standard IP** fields. The rc-65558 "IP blocked" is gone — the **full sandbox refund suite runs 5/5 green** (partial, void, double-refund race, over-refund guard, gateway-decline rollback), proving the box IP will work for live refunds + the reconcile QUERY too.
- **Real-world settlement nuance (not a bug):** a same-day card auth is captured-but-UNSETTLED; the gateway won't REFUND it → a **full same-day refund VOIDs** it (works), a **partial same-day refund isn't possible until it settles** (next working day). Code handles both safely (partial decline rolls back, no money moves).
- **Friendly message added** (`refundDeclineMessage`, unit-tested): a same-day partial now shows "This payment hasn't settled yet … refund it in full to return money today" instead of the raw gateway text; other declines pass through verbatim.
- **C8 instrument CONFIRMED (Peter): credit note IS the way — go.** The VAT-reversal automation (shipped `349368a`) is deployed + config-verified on prod (live Zoho org, accounts@ verify recipient, COMMS_DRYRUN=false); **live-active** — BACS refunds fire it now, card refunds fire it after the gateway REFUND_SALE. CAVEAT: prod holds test data but points at the LIVE Zoho org, so exercising a refund now posts a REAL credit note (the go-live flush doesn't touch Zoho — void test-phase notes by hand).
- **Verified:** tsc 0 / lint 0 err / **1155 vitest** / build. **Only remaining:** the broader card-payments go-live flip (LIVE creds + Settings toggle + real-card test) — Peter's call. Detail in memory [[marley-takepayments]] + go-live checklist C7/C8.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
