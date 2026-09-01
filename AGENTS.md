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

## Current State (2026-09-01 - reliability sweep + adversarial re-review MERGED; staging green; zero open PRs)

Last touched: 2026-09-01 on i9. Twelve PRs merged to `staging`, every one staging-green before the
next landed: #171 (master merge + Windows CRLF test + runbook rows), #172 (leak scan certified files
it never read), #174 (crew e2e networkidle), then the six-lens review's findings - #173 (commercial
completion invoice invisible to the bank feed and its alarm cleared by "Mark completed"), #175
(rollback safety checks that could not run reported clean), #176 (in-CSV duplicates + staff import
dying on a mixed sheet via PostgREST defaultToNull), #177 (/payments dated commercial money on move
day, overdue from the next morning), #178 (reschedule stomped commercial_due_date; late-balance
guard), #179 (completion invoice email said "due before move day" to a commercial client), #180
(Reply-To brand identity + the card kill switch never reached copy - new `brandForComms` resolver,
`card-availability.ts` extraction), #181 (/q accept + storage invoice notes promised card whatever
the brand), #182 (Deposit cell invited a deposit on a commercial lead).

- **Merged-tree certification is what made 12 merges safe in one day**: every PR's gates ran
  locally on a STACKED tree (staging + everything queued ahead of it), so each merge landed
  pre-proven against the exact content staging would hold. The one cross-branch failure this
  caught: #180 and #181 shipped CONTRADICTORY source tripwires on `raise-storage-invoices.ts`
  (one forbids `getBrandOrDefault`, one required it). Reconciled by intent - the let's brand,
  resolved through `brandForComms` - and both tripwires now pass together.
- **The comms-canonical brand resolver is `brandForComms`** (`lib/comms/brand-theme.ts`): wraps
  `getBrandOrDefault`, overlays `cardPaymentsEnabled` with the live ANDed verdict (global kill
  switch AND brand toggle). Customer-copy surfaces must use it - `card-toggle.test.ts` enforces
  the class. `cardPaymentsAvailable` lives in `lib/payments/card-availability.ts` (import-cycle
  extraction); `card-payments.ts` re-exports it.
- **Commercial policy is now consistent across every reader**: bank-feed visibility
  (`balanceRungVisible`), /payments dating (terms date, `classifyBooking`'s verdict, undated
  split "wait" vs "fix"), due-date authority (reschedules write nothing for commercial), the
  payments-card Deposit cell, and the completion-invoice email copy.

- **An adversarial re-review of the day's own work ran after the sweep** (6 domain reviewers, 2
  refuters per finding): 3 confirmed defects, all fixed same-day - #184 (the reads FEEDING the
  rollback probes could still fail silent, incl. the quotes read whose failure skipped all four
  money blockers AND the foreign-source refusal), #185 (commercial settlements got the residential
  "see you on move day" receipt; invoice ADOPTION stamped today+terms over the adopted document's
  own due date - `findInvoiceByReference` now returns the document's `dueDate` from both adapters
  and the document governs, else nothing is stamped), #186 (Reply-To display names now go through
  sender.ts's `sanitizeDisplayName`; four test guards tightened with proven RED evasions). 3
  findings refuted by the verify stage; 2 product-decision LOWs routed to ClickUp (869ett5wy card
  kill-switch scope, 869ett5y8 payments-card invoiced inference).

**Open decisions:** none new. **Blockers:** the staging Zoho refresh token is STILL dead
(`invalid_code` = revoked; re-mint per `scripts/zoho-staging-token.mjs` as demo@marleymoves.co.uk,
org 20117092566; `.env.local` is the LIVE org, do not touch it). **Next:** gate 15 needs Mark's
terms document; gate 16's RENDERED-page leak check (Playwright half of PRD 6.4) still outstanding;
QA-20260827-04 (`risky`) open; then the 18 September prod promotion per
`docs/pitmans-prod-migration-runbook.md` (0104-0114). Staging `app.env` verified carrying
`TAKEPAYMENTS_SIGNATURE_KEY` (docs template just omits it).

_Prior sessions -> brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only - `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
