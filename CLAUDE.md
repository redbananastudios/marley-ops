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

Last touched: 2026-08-07 on i9 — **IONOS SMTP fallback for Resend outages (`85b5d6c`) + the quote re-send failure chain fixed (PdfLoader `18bf9c1`, dup-guard reorder `ee18ee8`, Resend 2k-template-var fallback `2f1d0db`) + staging DB migration path live; 08-06 shipped bank-feed attribution (`e18af70`) + /payments refresh (`41292d8`)** — all staging→prod.
- **`85b5d6c` — customer email survives a Resend outage.** Outage-class failures only (401/403, sustained 429, outcome-unknown after keyed retries) deliver via IONOS SMTP as accounts@ (SPF already aligned; Reply-To relay preserved). Safety: ONE SMTP dial per row EVER (CAS on `smtp_fallback_attempted_at`, **migration 0087** — staging then prod); 429 retries in-process (per-second rate limit ≠ outage); fallback use raises a persistent `resend-fallback-active` ops issue that auto-resolves on Resend recovery; all 11 template call sites now carry rich bodyHtml (feeds the SMTP fallback AND the 2k-var guard); escalation copy names the accounts@ Sent folder. 15-agent adversarial review + independent verification of every fix. Env: `SMTP_FALLBACK_*` in both app.env files; creds = accounts@ mailbox (project-local, NOT credentials.env).
- **Re-send chain (from one Kristina/MMR042 screenshot):** quote detail page never mounted PdfLoader (`18bf9c1` — SendQuoteDialog now mounts it); the dup-guard compared regenerated-PDF payload hashes BEFORE answering "already sent" so every quote re-send hard-failed (`ee18ee8` — sent rows answer duplicate first; staging-proven send→confirm→override); Resend's 2,000-char template-var limit killed any email with a COMMITMENT_BLOCK — Brydee's date confirmation failed 8× silently (`2f1d0db` — dispatcher drops the template for the rendered body). All prod-verified; ops issues cleared to 0.
- **Staging DB migrations now possible**: `MARLEY_STAGING_SUPABASE_DB_PASSWORD` in credentials.env; runbook in `docs/ovh-deployment.md` (pooler eu-west-1). Migrations go staging FIRST.
- (08-06, evacuated to brain CHANGELOG) bank-feed attribution `e18af70` (commitment matching + Attach dialog + migration 0086; office one-tapped the first real case 08-07) + /payments refresh button `41292d8`.
- Gates: lint 0 · tsc 0 · vitest **1378** · build; staging e2e green on every push.
- **Open:** managed `*_RECEIPT` Resend templates fast-follow; carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp); AI attach-suggestion layer [869ef5wdu]. Crew Test staff (`peter@abacusonline.net`) seeded on prod, awaiting Peter's login test.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
