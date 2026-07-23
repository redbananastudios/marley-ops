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

Last touched: 2026-07-22 on i9 (latest) — **STORAGE BILLING V2 HARDENED for go-live: full 3-lens review → every finding fixed, verified, shipped (migration 0076).**
- **Peter's directive: "everything fixed, go-live imminent."** A 3-reviewer deep review of the v2 ship found 12 deduped defects (all orchestration-layer; the pure engine was clean). All fixed via a 4-agent parallel build + 15-agent adversarial verification (11/12 verified airtight; the 1 fail-open + 8 secondary regressions the verifiers caught were fixed same pass). Full inventory: `docs/storage-billing-v2-prd.md` §8.
- **Money core** (`lib/storage/raise-storage-invoices.ts` rewritten): strict paged ledger reads → `RaiseSummary.fatal` aborts the raise on ANY read failure (cron money-alerts it; release dialog warns "couldn't verify"); claims store `handling_event_ids` and the raise NEVER re-sweeps a claimed event (kills the crash/double-sweep class); Zoho orphan adoption verifies the amount (mismatch → alert, never adopt); new `repairPendingStorageClaims` (cron + let-scoped on release) adopts/releases/alerts claims stranded pending >1h; stranded-events + email-failure + repair alerts wired into the cron.
- **Guards** (`app/(dashboard)/storage/actions.ts`): crate reopen blocked once invoiced (fail-closed); events only on open crate lets dated start..today; crate rate always positive + locked once invoiced (UI mirrors); overbilled note fires ONLY for crate arrears/final windows (minimum + period bill in full by policy); atomic honest handling-event delete.
- **RLS (0076, applied local + prod):** events UPDATE policy dropped, DELETE = office+unbilled, INSERT pins created_by, amount>0 checks; **storage_invoices office INSERT/UPDATE dropped** (claims are service-role-only); supplier (Sandys) costs moved to admin-only `storage_supplier_rates` + server-only `lib/storage-supplier.ts` — estimators can no longer see cost/margin anywhere; `signatures.ack_labels` evidence on both storage signing paths.
- **Verified:** tsc 0 / lint 0 err / **1135 vitest** / build; e2e storage spec 4/4; live dev cron smoke: crate minimum £144 (£84 + £60 swept ingress, event marked, Zoho-linked) + idempotent re-fire 0 + repair/stranded clean.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
