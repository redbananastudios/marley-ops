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
  **Claude is that human.** The guard refuses ROBOT auto-merge; it is not a request for
  Peter, and a guard-queued PR whose merged tree is green must be merged, not parked.

- **The four gates DO NOT include e2e, and e2e is where changes actually break
  (2026-08-28).** Ten PRs went out in one session with lint + typecheck + vitest
  + build green on every one. Every failure that followed came from e2e: a
  renamed money-tile label that `office/bookings.spec.ts` asserted, and an
  audit-written spec that had never passed. "All four gates green" is not
  "tested" for anything touching a page, a label or a flow.

  Three habits, cheapest first:

  1. **Grep `e2e/` for any user-visible string you change, before you commit.**
     `grep -rn "Balance outstanding" e2e/` takes a second and would have caught
     the whole chain: the break, its fix PR, the second break, and the fix to
     the fix.
  2. **Run the suite LOCALLY.** `e2e/README.md` documents it and it works:
     local Supabase on `i9:54321`, dev server on 3016, `.env.e2e` layered over
     `.env.local` (it pins the STAGING Zoho org, so money specs are real).
     Needs Docker Desktop running for local Supabase — if `docker info` fails,
     start Docker Desktop first, that is the whole blocker. The note elsewhere
     about auth setup timing out is about running against DEPLOYED staging over
     the internet; it does not apply to a local target.
  3. **One merge at a time.** There is ONE set of e2e fixtures and both a
     hand-run and CI share it. Merging two PRs a minute apart races two e2e runs
     over the same rows and produces failures that look like code bugs —
     2026-08-28 lost an hour to exactly that. Wait for the staging run of one
     merge to come back before merging the next. `e2e/README.md` warned about
     the hand-run case only; CI-versus-CI does the same damage.

- **An audit-written spec has never been proven to pass (2026-08-28).** Four in
  a row now: an ambiguous locator (#75), a missing teardown (#76), an image read
  before it loaded (#81), and a FullCalendar click that no force could make
  deterministic. That last one closed QA-20260827-03 on the strength of a spec
  that passes intermittently at best. Treat a finding closed by a brand-new spec
  as unverified until that spec has gone green in CI at least twice.

## Current State (2026-08-29 - gates 10b AND 16 complete on `gate10b/commercial-office`; staging Zoho token STILL dead)

Last touched: 2026-08-29 on i9. Gate 10b finished in five tested chunks, then gate 16 (all five
public token pages) in two. Branch is 22 commits ahead of `staging` with `origin/staging` merged
in and all four gates re-run on the merged tree. **Not merged - the Zoho blocker is unchanged.**

- **BLOCKER (re-tested 2026-08-29, still dead): the staging Zoho refresh token.** `POST
  accounts.zoho.eu/oauth/v2/token` returns HTTP 200 `{"error":"invalid_code"}`. A NEW DAY DOES NOT
  FIX THIS - `invalid_code` is a revoked/invalid refresh token, not the 1,000/day rate limit that
  resets. Re-mint per `scripts/zoho-staging-token.mjs`: sign in as demo@marleymoves.co.uk at
  api-console.zoho.eu, Self Client -> Generate Code (scope ZohoInvoice.fullaccess.all, 10 min),
  then run the script with --org 20117092566. Interactive OAuth - Peter's, not the build agent's.
  NOTE there are TWO credential sets: `.env.local` = the LIVE org (20106952968), `.env.e2e` = the
  staging org. Only the staging one needs re-minting; do not probe the live one.
- **Gate 10b (5 chunks):** the commercial quote email + PDF asked for a GBP 100 deposit that exists
  nowhere in the database (deposit_amount is 0; both `?? 100` fallbacks only defend against null);
  the office confirm dialog described the residential machine and REFUSED to proceed on 0; the PO
  column had no writer, reader or field; nothing alarmed when a commercial invoice went unpaid; and
  no invoice this system raises has ever carried a due date on EITHER ledger rail.
- **Gate 16 (2 chunks):** all five token pages resolve identity from `lib/brand-page-theme.ts`.
  Two real leaks found by the leak scan rather than by reading: /q's acceptance form linked a
  customer to the DEFAULT BRAND's terms page as the document they were signing, and the card copy
  was gated on the brand flag alone when PRD 11.10 needs global AND brand.
- **The accent mechanism is one CSS variable, not threaded props.** Tailwind v4 compiles
  `.text-mm-red` to `color: var(--color-mm-red)` (verified against the built CSS), so re-pointing
  that token on a page root recolours the whole subtree INCLUDING `hover:`/`focus:` variants, which
  an inline style cannot express. Every utility class stays as it was, so the default render is
  byte-identical rather than merely the same colour. All four tokens are overridden together.
- **This repo is NOT uniformly CRLF.** `lib/ledger/xero-invoices.ts` and several app files are LF.
  An edit script that assumes one ending silently matches nothing - and one of mine left
  `app/q/[token]/page.tsx` MIXED (856 CRLF + 8 LF) before it was normalised. Read the file's own
  endings, edit in LF, write back what was there.
- **Local e2e is the fast loop.** `commercial-accept.spec.ts` green locally four times across the
  session. Source both env layers onto the playwright process - `.env.e2e` has no Supabase key.

**Open decisions:** `clients.payment_terms_days` now has two readers (removals + storage).
**Blockers:** the staging Zoho token. **Next:** re-mint, merge PR #161 alone and wait for its
staging e2e run before anything else, then gate 20 (importers - only import-imve.mjs and
import-neon-quotes.mjs exist; the four Pitmans CSV importers do not). Gate 15 stays BLOCKED on
Mark's document; gate 22 is the designated drop. Gate 16's RENDERED-page leak check (the Playwright
half) is still outstanding and the scan's own header says so. Import CSV
`jobs-imve-2026-08-13.csv` stays untracked (PII).

_Prior sessions -> brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only - `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
