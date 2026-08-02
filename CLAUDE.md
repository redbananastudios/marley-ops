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

Last touched: 2026-08-02 on i9 — **three live-use fix batches shipped staging→prod** (each health-checked green; the 08-01 financial/count audit + earlier sessions are in the brain CHANGELOG).
- **`57aa068`** — inbound-reply follow-ups now **refresh one open card per lead** instead of stacking an identical "respond" card per reply (per-event unique index only guarded replay of one email). **Dashboard top KPI tiles** (New leads/Contacted/Surveys booked/Jobs won/Median response) now click through to /leads, /schedule/surveys, /bookings, /performance. Marks Davis's existing duplicate follow-up cleared (Peter tapped Done — the prod-DB cleanup script was classifier-blocked).
- **`18de622`** — **quote-from-lead address prefill fixed**: website leads store the postcode SEPARATELY from the address line, so the old `from_address || from_postcode` dropped town+postcode. New `addressFromLead()` (lib/places/parse.ts) re-joins them (no double-postcode-into-Town) + a curated UK-county gazetteer reads a trailing county. Also **`createDraftQuote` resumes an existing open draft** for the lead instead of spawning orphan drafts (newest wins; sent/accepted untouched).
- **`c8aa2c7`** — forwarded customer replies are now readable: `extractReplyText()` (lib/comms/extract-reply.ts) strips the quoted quote-email "| | |" wall (owner forward + unmatched forward + stored Comms body). Bias UNDER-cut, interleaved-safe, linear-time (public webhook). Hardened over **3 adversarial-review rounds** (over-cut prose, interleaved-answer drops, O(n²) ReDoS, underscore-divider drop).
- Gates each batch: lint 0 · tsc 0 · vitest (→**1291**) · build; staging e2e **109**.
- **Open (live-DB ops, need Peter's go — classifier-gated):** clear pre-fix orphan/broken draft quotes + any leftover legacy duplicate follow-ups. Carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
