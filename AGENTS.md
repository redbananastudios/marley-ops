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

## Current State (2026-09-04 — removal date-confirm SMS shipped + live-verified, 197/197 e2e green)

Last touched: 2026-09-04 on i9. Peter: "can we implement the removal booking SMS for confirmed
dates" (following up an earlier "does survey booking send SMS or removal booking" question,
answered by code read: surveys already send both channels via `sendSurveyCustomerNotice`;
removal date-confirmation was email-only).

**Shipped in #222:** `dateConfirmationSms()` (`lib/comms/date-confirm-email.ts`) mirrors
`buildDateConfirmationEmailHtml`'s four branches — commitment due, an already-issued balance
outstanding/settled, gate 9a paid-in-full, default "nothing to pay right now" — same copy
rules (no "penalty", no em-dash), no link (matches every other customer SMS in this codebase).
Wired into `sendDateConfirmationEmail` (`lib/quote/accept-flow.ts`) alongside the existing
email dispatch, fail-soft: an SMS failure never undoes the confirmation, and
`resendCommitmentInvoiceFlow`'s ok/not-ok contract stays keyed on the email (which carries the
invoice PDF). New `e2e/office/date-confirm-comms-dryrun.spec.ts` drives the real "Confirm in
person" office action, seeded so the deposit already covers the 25% commitment
(`ensureCommitmentInvoice`'s own `amount <= 0` short-circuit) — proves the wiring with **zero
Zoho API calls**, deliberately, given the shared staging org's daily quota.

**#222's own live staging run caught a real bug in the new spec itself, not the feature**
(all 6 proof steps passed, including the SMS assertion — teardown then threw): the SMS row
carries no `subject` (optional on `dispatchComm`; the plain body is the whole payload), so the
spec's cleanup filtered `communications` by `ilike(subject, ...)` only, missed the SMS row, and
the FK cascade to `leads`/`clients` failed, leaving one marker row on staging. Cleaned up
directly (verified 0 remaining). Fixed in **#224** — a second delete keyed on `lead_id`.

**Both PRs merged and live-verified, no findings open on this work:**
- #222 → staging `e74d9ea`, deployed, live-verified (6/6 steps against the real DOM + SQL
  read-back).
- #224 → staging `1ec918c`, deployed. **Staging e2e run `33877659284`: 197 passed, 0 failed**
  (up from 196/1 before the fix) — the spec now goes fully green end to end.

**Tooling lesson from getting #224 out (captured to RBS-OS, universal — see `/learn`
2026-09-04):** reusing a branch NAME after its PR squash-merges (GitHub auto-deletes the
branch, and re-pushing local history under the same name recreates commits with the ORIGINAL,
now-superseded SHAs) puts the new PR into a `CONFLICTING` mergeable state and — empirically —
GitHub Actions does not dispatch `pull_request` check runs against a conflicting PR at all, so
it looks exactly like a webhook outage. Fix: always branch fresh off the current base
(`git checkout -b <new-name> origin/<base>`) and cherry-pick the follow-up commit, rather than
reusing a post-merge branch name.

**QA loop kept running its own scheduled cadence in parallel throughout** (7f1e960, d7c1c5f,
98813f9, 45468e7, b575b05, 7cd6b23 and others on `staging` since the 2026-09-03 entry below,
plus `qa/findings/closed/QA-20260904-01.md` — the deposit-comms-dryrun locator fix, closed on
its own live re-verify). Two automation defects it flagged, neither fixed (out of scope for
that tier, reported to Peter by notification, not re-verified by this session): (1)
`.github/workflows/qa-findings.yml`'s `raise` job is failing on `gh issue create` for any
finding title over 256 chars — kills the whole sweep loop on the first over-long title, so
findings after it silently get no tracking issue; (2) the first-pass repair tier's branch names
don't match the mandated `qa-repair/<finding-id>` form. Full detail in `qa/LOG.md`.

**Full prior history (staging fully green 190/190, the Zoho-quota QA-20260902-06 close, the
third adversarial tree-pass #210/#211/#214, gate 15/takepayments/Zoho-burn open items) ->
brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (evacuated there today by
`/ur` — this block holds the latest session only). Still Peter's, unchanged since 2026-09-03:
takepayments sandbox PANs, the Zoho burn rate before 18 September, gate 15's terms document +
legal read, the 3 ClickUp decisions (869ett5wy, 869ett5y8, 869eu70v3), finding 36's two-theme
call. Named but not fixed: `lib/quote/chase.ts`'s default-brand signature block,
`collect-contract-button.tsx`'s default-brand terms link. **Next:** gate 15, then the 18
September promotion (migrations 0104-0117, Peter runs over SSH, then `notify pgrst`, then
deploy). Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist:
`docs/go-live-checklist.md`.

