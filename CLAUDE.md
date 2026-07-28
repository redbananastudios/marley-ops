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

Last touched: 2026-07-28 on i9 — **Refund → Zoho VAT reversal FULLY AUTOMATED + adversarially reviewed (Peter chose automation over the guard-rail).**
- **What it does:** on a deposit refund/void the panel auto-raises a Zoho **credit note**, records its refund, stores the id, and emails accounts@ to **VERIFY**. Customer money back IN FULL (not a held credit). One shared orchestrator `lib/payments/refund-vat.ts` `reverseDepositVatInZoho` drives BOTH rails — **card** (`refundCardPayment`, mode creditcard) auto money-back; **BACS** (`markRailRefundedAction`, mode banktransfer) money-back stays a manual bank transfer. New `lib/zoho.ts`: `createCreditNote`/`refundCreditNote`/`findCreditNoteByReference`/`invoiceCarriesVat`. Migration **0078** (`card_payments.zoho_credit_note_id/number`, applied local **+ prod**). Fail-soft — never throws; falls back to a tracked reminder. Forfeited/retained deposits keep their VAT (untouched).
- **Reviewed** (5-dimension adversarial workflow + `/code-reviewer`) → **6 findings, ALL FIXED**: is_test rows never touch Zoho; a lost-response on CREATE is adopted (no double credit note); the credit note MIRRORS the original invoice's VAT (no phantom reversal across the VAT-enablement boundary) AND requires the deposit invoice to exist; a failed verify email leaves a durable follow-up; BACS gets an events_log audit link.
- **Verified:** tsc 0 / lint 0 err / **1152 vitest** / build; Demo-Zoho E2E (create→refund→idempotent→fallback-never-throws) proven; test isolation hard-guards the Demo org, sandbox E2E strips ZOHO_*.
- **Remaining go-live gates (both Peter's, on checklist):** **C7** register box IP `51.195.253.165` in the takepayments MMS (refunds + reconcile QUERY are IP-blocked without it); **C8** accountant confirms a "refunded credit note" is the right instrument + VAT-period treatment before it runs on the LIVE return. Detail in memory [[marley-takepayments]].

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
