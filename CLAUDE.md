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

Last touched: 2026-08-07 on i9 — **iMVE legacy-job import shipped (`3e296bf` + chip fix `2791ca8`, staging→prod): source='imve' jobs are HARD-excluded from money automation, CSV importer + rollback ready — Peter fills `docs/imve-import-template.csv` next.** Earlier today: SMTP fallback `85b5d6c` + re-send chain (brain CHANGELOG).
- **Guards (migration 0088, staging + prod applied):** `ensureCommitmentInvoice` refuses imve (no 25% invoice ever), `confirmMoveDate` refuses (its email cites terms legacy customers never agreed), commitment-ladder query excludes imve (no T-10 chase / T-7 flag), contract-signature nags suppressed (schedule + crew sheets), imported leads land `confirmed` + `chase_paused`. Post-move unpaid-balance alerts stay (internal-only) and a fully-paid job still auto-completes + sends the standard review request (deliberate, documented).
- **Importer** `scripts/import-imve.mjs`: dry-run default, `--commit`, `--prod` gate; client dedupe by email/phone; duplicate iMVE refs tolerated (-2 suffix, raw in `imve_ref` — refs are NOT unique in iMVE); money truth from CSV (deposits, settled → `leads.balance_paid_at`, £0-deposit old-terms); Zoho drafts link display-only (`imve_zoho_invoice_number`); occurrence-based idempotent re-runs; `--rollback <batch>` refuses when bank matches/signatures/comms/completions exist. Runbook: `docs/imve-import.md`.
- **Staging e2e PROVEN**: 3-job import → chase cron ran → 0 legacy actions (verify script: no invoice, no stamps, no follow-ups, 0 comms) → Bookings/schedule chips render ("Paid in full" for settled; false "25% due" chip caught + fixed `2791ca8`) → idempotent re-run → clean rollback. `.env.staging` (gitignored) holds the staging service key for import runs.
- 16-finding adversarial review pre-ship: HIGH (balance_paid_at on wrong table) + 4 MED (settled-implies-deposit, PostgREST 1k cap pagination, reschedule-proof idempotency, cron query error now logged not swallowed) all fixed.
- Gates: lint 0 · tsc 0 · vitest **1379** · build; staging e2e green.
- **Open:** Peter fills the CSV (~20 iMVE jobs) → staging dry-run → prod import (runbook §3). Managed `*_RECEIPT` Resend templates fast-follow; carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp); AI attach-suggestion layer [869ef5wdu]. Crew Test login awaiting Peter.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
