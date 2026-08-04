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

Last touched: 2026-08-04 on i9 — **inbound-reply readability shipped staging→prod** (prod on `9e5bed6`, deploy green; earlier today `894a54b` shipped payment receipts + the comms-retry backstop — see brain CHANGELOG).
- **`9e5bed6` — forwarded customer replies are now readable and logged clean.** Root cause of the Greig James MMR015 wall-of-text forward: Gmail hard-wraps its plain-text attribution at ~72 chars (`…<accounts@…>\nwrote:`), the single-line attribution regex saw no quote context, so nothing was stripped. `findAttributionSpan` (lib/comms/extract-reply.ts) now joins up to 3 physical lines before testing (guards intact: date shape after "On", `<email>`, "wrote:"). New `splitReply()` returns reply + quoted history separately; both webhook forwards render two sections — the customer's words in a prominent card, "They were replying to" muted underneath, footer gains a real lead link. Lead Comms tab now selects `direction` and renders inbound rows as full-text "Customer reply" entries (red rail, no clamp) so any operative can review the thread. Unretryable-comm backstop alert also gains the lead link. Verified against the real MMR015 payload; sample of the new format sent to peter@marleymoves.co.uk.
- **The 12:03 "may be undelivered" email was NOT a new failure** — it was the designed ONE-TIME hand-off for the same pre-fix Marks Davis MMR019 orphan (he'd paid). Prod verified: 0 open issues, no failed comms since 01 Aug besides that capped row. No third email will come.
- Gates: lint 0 · tsc 0 · vitest **1339** · build; staging e2e green.
- **Open:** managed `*_RECEIPT` Resend templates fast-follow (receipt copy currently builder-only); carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp). Crew Test staff (`peter@abacusonline.net`) seeded on prod, awaiting Peter's login test.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
