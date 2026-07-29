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

Last touched: 2026-07-29 on i9 — **PRE-LIVE INSPECTION: 5-role adversarial review + 150-view responsive audit; 22 issues fixed, 0 blockers, all gates green.**
- **Scope:** 5 opus agents reviewed every role (office/crew/estimator+public/payments/media) against the LIVE DB; a browser audit walked all routes as each role at mobile/tablet/desktop (150 views). Verdict: app well-hardened, **no blocker**.
- **Fixed + verified (tsc0/lint0/1161 vitest/build):** 2 HIGH — admin gate now `active`-aware (a deactivated admin can't self-reactivate/mint admins); card refund timeout-after-commit → `needs_review` + money alert (was a double-refund). MED — crew email `ilike`→`likeEscape` ×7 (wildcard cross-crew access); invoice-line £10k cap; survey-photo + job-note delete-object-first (orphan). LOW — capture photo/voice abort; accept/decline/date-confirm free-text bounds; quote-status transition guard; guarantee-line total; card mint-cap + first-submit-only cubic alert; frame Content-Length bound; handling-event pinned to rate card; signSurveyPhotoUrls row-check; dashboard+finance aggregates strict; safe security headers. UI — finance/statements mobile overflow; /growth dup-key.
- **Migration 0079** (`refunded_pence ≤ amount_pence` CHECK) applied local — **APPLY TO PROD with 0078**.
- **Then Peter said "fix all" → both prior deferrals now SHIPPED + verified:** per-payment VAT mirror on a straddle refund (pure `planRailVatReversals` + 5-case test; a single-payment rail collapses to the exact prior call so ordinary refunds can't regress) and the **full resource-restricting CSP** (built from the real origins — Supabase connect/img/media, R2, google.com maps embed, takepayments form-action, cdnjs pdfmake — re-audited across 50 views: 0 violations; the audit caught a client pdfmake CDN load, cdnjs allow-listed). One open follow-up: nonce-based script-src (still `'unsafe-inline'`/`'unsafe-eval'` for Next hydration). Agreement-RLS any-version + cert-resend left by design.
- **Zoho test/live:** the go-live flush (C5) must VOID test-phase Zoho docs before the first real refund (added to checklist C5).
- Detail: memory [[marley-takepayments]]; decisions log 2026-07-29; go-live checklist C5/C8.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
