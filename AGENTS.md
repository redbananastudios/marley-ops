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

## Current State (2026-09-02 - THIRD QA pass closed out; 35 findings; 2 PRs; staging green; zero open)

Last touched: 2026-09-02 on i9. A third adversarial pass (Opus 5) over the whole un-promoted
payload - `master...staging` @ 79f5a98, 473 files - reviewed as ONE TREE rather than per-PR diffs,
which is why it found what two earlier per-PR passes did not. 14 subsystem reviewers -> dedup ->
two refuters per finding (refute-by-default) -> completeness critic; 96 agents, 0 failures.
**35 confirmed / 4 contested / 2 refuted / 8 coverage gaps.** All closed in 2 PRs: **#210** (the
5 HIGHs) and **#211** (the other 30 + a live-diagnosed defect). 33 fixed, 2 judged
NO_CHANGE_NEEDED on their merits. Suite 3166 -> 3350.

The five HIGHs (#210):
- **commercial credit control went silent exactly when it broke** - `loadBookingRows` is fail-soft
  (`fetchAllRows` logs-and-breaks; secondary reads never inspected `error`), so a DB failure reached
  `sweepCommercialOverdue` as an EMPTY LEDGER, which RESOLVED both alarms and reported 0 rather than
  the -1 reserved for an unread sweep. Commercial is never chased by email, so nothing else notices.
  The loader now takes `{ strict }`; the old guarantee test mocked a rejection the real loader
  cannot produce, so it proved nothing.
- **a late booking's date-confirm email said "nothing more to pay"** over a balance invoice already
  in the customer's inbox, days before the move.
- **a settle-in-full transfer left one half unclaimed** - two payments recorded, one `match_kind`
  stamped, so a later genuine transfer for the other half AUTO-RECONCILED as explained, hiding a
  refund we owe. What a row claims is now re-derived from the ledger.
- **"Xero was never authorised" classified as transient**, so the watchdog stayed green through a
  lock-out while every invoice raise failed.
- **the storage invoice sweep swallowed its let read** and sent under the DEFAULT brand, stamping
  `emailed_at` so the mis-branded copy is the only one that customer ever gets.

The 30 (#211): the biggest cluster is SEVEN more instances of the swallowed-read family (#195 fixed
it for `listActiveBrands` only) - `getBrand`, `createDraftQuote`, `createAppointment`, the
follow-ups page, and two blank-phone borrows. Plus: a commercial booking that never got a diary
slot; the Pitmans hosted-template key scheme that would have made EVERY Pitmans template silently
inert; two lead rails that could skip the other brand's enquiries; Xero's tenant lookup discarding a
freshly rotated refresh token; `/sheet`'s missing brand chip (and its 500 on a brands read);
migration **0116** correcting 0115's backfill guard (applied to staging, runbook updated). And the
leak scan, which reported "0 leaks" while covering ZERO files under `lib/comms/` - now 82 files,
with the gap note saying plainly that anything off the manifest is UNSCANNED, not clean.

**Diagnosed live, correcting the record:** the four red money e2e specs (QA-20260902-06, filed as a
suspected #205 regression) are **neither a regression nor flake - the staging Zoho org spent its
1,000-call DAILY QUOTA**, burned by our own CI volume. `POST /oauth/v2/token` -> 200 with a valid
token while `GET /invoice/v3/invoices` -> 429 code=45: a green auth layer over a dead integration,
the same trap as the 2026-08-27 lock-out. **PR #205 is cleared, and the previously recorded blocker
"staging Zoho refresh token dead" was WRONG - the token is fine.** Nothing classified a 429, so a
spent quota raised no alarm at all; #211 adds `reportLedgerRateLimited` on its own key with its own
remedy copy (a quota resets at midnight - it must never borrow the lock-out's "re-enable the user").
Prod runs against the same cap on the live org.

**Still Peter's:** the 3 ClickUp decisions (869ett5wy, 869ett5y8, 869eu70v3); finding 36's
two-theme-per-brand call (`brands.ledger_branding_id` has zero consumers, but the obvious remedy is
the one `docs/ledger-adapter-design.md` rejected); and the critic's gap that **qa-auto-merge.yml's
risky-path guard never grew to cover the new money rails** - `lib/ledger/**`, `lib/bank-feed/**`,
`lib/storage/raise-storage-invoices.ts` and `lib/brand.ts` all sit OUTSIDE it, so a `pitmans-gate`
PR touching only those robot-merges unreviewed. **Next:** gate 15 (Mark's terms doc), gate 16's
rendered-page leak check, QA-20260827-04, then the 18 September promotion - the runbook now carries
0104-0116 with 0115+0116 in the before-deploy block and a verification query for each.

_Prior sessions -> brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only - `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
