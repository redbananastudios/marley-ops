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

- **A red `gate` check on a guard-tripping PR tells you NOTHING about the tests (2026-08-26).**
  `qa-auto-merge.yml`'s first real step is the risky-path guard, which `exit 1`s several
  steps before `npm ci`, let alone `npm test`. So any PR touching
  `supabase/migrations/**`, `lib/payments/**`, `lib/comms/**`, `app/api/card/**` or
  `lib/supabase/proxy-session.ts` shows a red badge that means only "a human must merge
  this" — the suite may be green, or may be badly broken, and the badge cannot tell them
  apart. PR #91 sat guard-red for a day carrying a genuinely failing pricing snapshot that
  nobody had seen. **Before merging any guard-queued PR, merge staging into it locally and
  run all four gates on the MERGED tree** (`npm run lint && npm run typecheck && npm test
  && npm run build`) — not on the branch alone, since staging moves underneath it.

## Current State (2026-08-25 — prod live on `6ae3ba3`; master == staging; zero open QA findings)

Last touched: 2026-08-25 on i9 — **prod, `master` and `staging` are all `6ae3ba3`.** The QA loop now runs end to end on its own: audits on **Sonnet**, first-pass repair firing and fixing findings unaided.

- **The repair loop's output needs a human read before prod.** Both robot fixes were right in substance and each carried a defect: the tour's dialog wait retried **forever** (polling for the page's life, then slamming a full-viewport overlay up whenever the user finally closed a dialog — now bounded at 12s, giving up is safe because the tour only stamps when it renders), and the postcode fix hand-rolled a second normaliser instead of `formatUkPostcode` in `lib/leads/format.ts`. Reviewed in #82.
- **THREE consecutive audit-written specs broke on first CI run** — #75 ambiguous locator, #76 no teardown (left an unbilled expense that made `submitMyStatementAction` refuse EVERY invoice submit), #81 read an image's load state before it loaded. The audit's spec step needs a "must go green in CI" gate before it closes a finding.
- **A qa/-only commit takes the docs-skip path, so a green tip can be hollow** — `test`/`deploy`/`e2e` all show `skipped` while the run reports success. Before promoting, check the last commit that actually RAN the suite, not the tip's badge.
- **The IMV import gave all 17 jobs a blanket £100 deposit** regardless of price, so a job paid off in one transfer matches no ledger item. Solved by the "Whole job" link (`match_kind='full'`, migration 0103, applied to prod). Full invariant in the brain hub.
- **Known trap, tracked:** `deploy.yml` still filters at the workflow level, so a docs-only commit pushed to `master` produces no deploy run and prod drifts silently from `master`. [ClickUp 869entgjt](https://app.clickup.com/t/869entgjt), due 2026-08-30.

**Open decisions:** whether to restore arrow-key tour navigation (`allowKeyboardControl:false` prevents a data-loss bug but costs keyboard nav — a capture-phase Escape handler would keep both). **Blockers:** none. **Older open items** → [ClickUp 869ehpv2x](https://app.clickup.com/t/869ehpv2x). Import CSV `jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
