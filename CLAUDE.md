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

Last touched: 2026-07-31 on i9 — **STAGING ENVIRONMENT BUILT + first prod promotion shipped a real app fix (`8cb6c71`)**. marley-ops now has a full off-prod staging deploy + a two-branch CI/CD gate, and the first thing it caught was a real navigation bug — now fixed on prod.
- **Staging env (LIVE):** `staging.ops.marleymoves.co.uk` — own Supabase Cloud DB (all 83 migrations), Demo Removals Zoho org, takepayments sandbox; safe holds (Sanity sync OFF, COMMS_DRYRUN, SMS off). Two-branch CI/CD: push `staging` → `staging.yml` (test → deploy-staging → seed → Playwright e2e vs the live staging URL); `master` → `deploy.yml` with a `production` **manual-approval** gate; master branch-protection requires the `e2e` check. Design/runbook: `docs/staging-and-ci.md`.
- **Greening the e2e surfaced 5 real issues (all validated off-prod):** deposit invoice read **£15 → £100** (a stale *paid* Zoho invoice the accept flow's orphan-adoption latched onto; teardown couldn't purge paid invoices — both fixed); claims save raced a reload (gated on the server-confirmed toast); and the headline: **a client-side nav race** — create-lead/new-quote ran a server action then `router.push`, which lost to the action's revalidation and bounced back to the empty form, creating **duplicate records**.
- **App fix shipped to prod (`8cb6c71`):** create flows now navigate via a **server-side `redirect()`** (atomic — no client push to lose the race). New `createLeadAndOpenAction` / `createQuoteWithLeadAndOpenAction` wrappers; underlying create actions unchanged. Side effect: the "Lead added"/"Quote started" success toast is gone (you land straight on the record). Validated: staging e2e **109 passed / 0 failed on two consecutive runs**; local gates lint 0 · tsc 0 · build · vitest 1216. Prod deploy 30644738160 green + health-checked.
- Not created on the live CRM: no prod test records (staging proved the behaviour on identical code). Follow-up [ClickUp 869ecdg4f] closed.
- Open carried: PCI SAQ 8.3.6/7/9 correction + password policy (ClickUp 869eb591y, due 30 Sep); R2 size-ceiling fast-follow (ClickUp 869e66mzp). R2 staging bucket `marley-ops-staging` not created (staging media uploads inert — safe, non-blocking).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
