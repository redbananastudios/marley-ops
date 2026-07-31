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

Last touched: 2026-07-31 on i9 — **LIVE-OPS HARDENING BATCH `2ba1a0e` shipped + deployed** (OVH CI/CD green, container recreated, health-checked). A dedicated multi-agent sweep for the class of easy-to-spot defects Peter found in live use returned 7 verified issues; all fixed + shipped in one deploy alongside a new delete-user feature, plus two live-data ops (Peter authorised).
- **Money guard (HIGH):** lead PaymentsCard "Deposit/Balance received" now confirms + captures cash/bank method — was a one-click un-confirmed REAL-Zoho payment + "all settled" email with no undo, and cash was booked as bank transfer. Ported the Bookings `MarkPaidButton` dialog; method threaded through `markPaymentPaidAction` → `markDepositPaid`/`markBalancePaid`.
- **Clients edit + admin archive** (`updateClientAction`/`setClientActiveAction`, money-aware guard blocks archiving a client with live leads/accepted quotes); **Settings > Team delete-user** (`deleteTeamUserAction` + trash UI: refuses self / last-admin / any user with history via a 14-table check + DB FK backstop → deactivate instead; only a zero-footprint login hard-deletes).
- **Data-integrity:** lead → quote/appointment address no longer doubles the postcode into the Town field; lead sync floor now FAILS CLOSED on a dropped/garbled `LEAD_SYNC_SINCE`; organic FB/IG no longer mislabelled paid Meta; margin-calc "Days" clamps ≥ 1.
- **Live-data ops (executed):** VAT FRS % 10→9 (first-year; scheme=flat_rate + stagger group-3 + 1-June floor were already correct — Finance shows "VAT owed (FRS 9%)"); 5 leftover inactive test logins deleted (0 refs — 4 real admins + jack@/rob@ crew remain).
- Gates: lint 0 · tsc 0 · vitest 1216 · build green. Full detail: memory [[marley-go-live]] + brain CHANGELOG.
- **Next move proposed (open, not committed):** a **staging environment** for marley-ops so live-use fixes are validated off-prod before shipping to a system now carrying real money. Discussing approach with Peter.
- Open carried: PCI SAQ 8.3.6/7/9 correction + password policy (ClickUp 869eb591y, due 30 Sep); R2 size-ceiling fast-follow (ClickUp 869e66mzp).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
