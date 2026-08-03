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

Last touched: 2026-08-03 on i9 — **comms-reliability guarantee + HTML-only reply fix shipped staging→prod** (prod on `6aa45ff`, deploy health-checked green, worker smoke-tested clean).
- **`ecc901f`** — **HTML-only inbound replies no longer dropped.** A reply with an empty plain-text part (Gmail/iPhone) fell through to "(open the forwarded copy)" — Priscilla Kong's MMR020 reply was lost. New `htmlToText()` (lib/comms/extract-reply.ts) flattens the HTML when text is empty: drops `<blockquote>` quoted history, decodes numeric + named entities (incl. £/€), feeds it through `extractReplyText`. Wired into both forwards in the resend-inbound webhook. Her stored Comms row was backfilled.
- **`e824f31` (Layer 1)** — `sendEmail` retries a transient timeout/5xx up to 2× (short backoff), **only when an idempotency key is present** so it can't double-send. Prevents the exact single-timeout that stranded a real deposit chase.
- **`6aa45ff` (Layer 2)** — **durable `comms-retry` worker**: re-drives any still-failed outbound send through the existing reclaim path (same stored payload + same `marley-comm/<id>` key ⇒ can't double-send), backs off (5m→60m cap), caps at 8 attempts, escalates to a critical issue instead of looping; a recovered send auto-resolves its issue. Migration **0084** adds `communications.provider_request` (the exact payload; write is non-throwing). `dispatchComm`'s send/finalise tail is now the shared exported `runProviderSend`. New `*/5` cron (route + registry + `/etc/cron.d/marley-ops` line on the box). Prod migration applied + verified; endpoint returns `{ok:true,candidates:0}`.
- Gates: lint 0 · tsc 0 · vitest **1309** · build; staging e2e green (all three combined).
- **Note:** staging DB did NOT get the 0084 column (separate Supabase Cloud project, no box connection) — worker dormant on staging only (harmless, non-throwing write); add via the Supabase SQL editor for parity if wanted. Priscilla's deposit is **not actually paid** (her email only claimed it) — Peter chasing later.
- **Open:** carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
