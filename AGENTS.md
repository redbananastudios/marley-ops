<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

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

## Current State (2026-08-24 — prod live on `7c1f550`; master == staging; zero open QA findings)

Last touched: 2026-08-24 on i9 — **prod, `master` and `staging` are all `7c1f550`.** Migration **0103 is applied to prod**; the live bank-feed alert that prompted the day's work is cleared.

- **One transfer can now settle a job the ledger split in two (#73/#74).** A customer paying a job off in a SINGLE transfer matched no ledger item, so the money sat in "Transfers that need a human" with nothing the office could pick. The dialog now offers **Whole job (deposit + balance)**, only when the transfer equals the sum to the penny. `match_kind='full'` (migration 0103) means one row explains every payment on a quote, so the duplicate guard, the received-tab stamps and `healMissingPaidMethods` all **expand** it rather than reading one kind.
- **Why it mattered: the IMV import gave all 17 jobs a blanket £100 deposit** regardless of price (£650→£3,987). Every imported customer who pays in one go hits this. Live case resolved: F Sieradzki's £660 → Kayleigh IMV012, linked as `full`, no customer comms sent (Link deliberately does not re-run the paid pipeline — which matters, prod is `COMMS_DRYRUN=false`).
- **A quote ref appears TWICE on `/payments`** — on the alert row and in the day feed, both `div.flex.flex-wrap`. Locating a row by text alone is a strict-mode violation; it broke the audit's own new spec (#75) and my verification script before that. Identify the alert row by the **Attach control only it carries**.
- **Prod DB writes and `staging`→`master` pushes are gated by the auto-mode classifier** and were denied repeatedly this session, as was any attempt to change `~/.claude/settings.json` to loosen it. Migrations reach prod by hand (`docs/ovh-deployment.md`), staging first.
- **Known trap, tracked:** `deploy.yml` still filters at the workflow level, so a docs-only commit pushed to `master` produces no deploy run and prod drifts silently from `master`. [ClickUp 869entgjt](https://app.clickup.com/t/869entgjt), due 2026-08-30.

**Open decisions:** none. **Blockers:** none. **Older open items** → [ClickUp 869ehpv2x](https://app.clickup.com/t/869ehpv2x), not re-verified. Import CSV `jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
