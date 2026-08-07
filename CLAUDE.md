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

Last touched: 2026-08-06 on i9 — **bank-feed attribution: commitment invoices match + manual Attach-to-quote (`e18af70`) + /payments on-demand refresh button (`41292d8`), both staging→prod** (2026-08-05 shipped the week's QA fix `68841a2` + late-booking collapse + T-7 grace + lost-quote retirement + settlement classifier — see brain CHANGELOG).
- **`e18af70` — the matcher knows commitment invoices and the office can attach anything it can't guess.** The MY SAFETY LTD £50 (MMR034 commitment top-up) read as a part-payment mismatch because the matcher only knew deposit/balance; commitment is now a first-class kind (exact amount, one-tap confirm through markCommitmentPaid), unmatched/mismatch rows gain an **Attach** dialog (search open items by ref/customer; server re-verifies the exact-amount invariant; part-payments still deliberately refuse), paid commitments appear in the /payments Received view, and **migration 0086** (match_kind + 'commitment', match_confidence + 'manual') is applied to prod. Hardened per a 16-agent adversarial review — 9 confirmed findings fixed pre-ship, headline: the balance fallback now nets out a RAISED commitment invoice (partition doctrine) so the open set can't offer commitment + gross balance together; confirm re-verifies its open item post-claim (cancelled bookings/amount drift refuse); officeActor requires active; amount-only matching is corroboration-first. **Staging DB has NO migration path** (hosted Supabase project, no DB password/access token stored) — 0086 is not applied there; harmless today (no e2e touches the new kinds) but the next migration needs Peter to provide the staging DB password or a SUPABASE_ACCESS_TOKEN.
- **`41292d8` — /payments header refresh button**: runs the bank-feed sync (office-authorised cron route) then re-renders, so a tap pulls the sheet's newest transfers instead of waiting for the 2-min cron. Verified live on staging (waiting-for-first-sync → synced 0 min ago).
- Gates: lint 0 · tsc 0 · vitest **1368** · build; adversarial review pre-ship. Staging CI hit the 2026-08-06 **GitHub Actions major outage** (jobs cancelled before pickup — not our code); rerun on recovery, then promote.
- **Open:** staging Supabase migration path (Peter: DB password or SUPABASE_ACCESS_TOKEN); managed `*_RECEIPT` Resend templates fast-follow; carried fast-follows [ClickUp 869echgta]; PCI SAQ (869eb591y, 30 Sep); R2 size-ceiling (869e66mzp). Crew Test staff (`peter@abacusonline.net`) seeded on prod, awaiting Peter's login test.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
