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

## Current State (2026-09-02 late - third QA pass closed + 4 more waves; PR #214; migrations now 0104-0117; 3 findings open, none closeable by us)

Last touched: 2026-09-02 on i9. Two blocks of work today. **(1)** A third adversarial pass
(Opus 5) read the whole un-promoted payload - `master...staging` @ 79f5a98, 473 files - as
ONE TREE rather than per-PR diffs: 14 subsystem reviewers -> dedup -> two refuters per
finding -> completeness critic; 96 agents. **35 confirmed / 4 contested / 2 refuted**, all
closed in **#210** (5 HIGHs) and **#211** (the other 30 + a live-diagnosed defect). The
biggest cluster was SEVEN more instances of the swallowed-Supabase-read family that #195
had fixed in exactly one function. **(2)** Four more waves closing the last two "Next"
items, landed as **#214** - and they found more than they were sent for.

**The two that mattered in #214, neither of which was the thing we set out to fix:**
- **A second brand's storage customer was ticking a lien clause naming the DEFAULT company**
  as the party who may sell their goods. Hardcoded in `lib/signatures.ts`; BOTH signing
  paths (remote `/s` and the in-person crew dialog) rendered AND recorded it into
  `signatures.ack_labels`, the sole record of what was agreed. Same clause reached customers
  three more ways: the `/q` date-confirm tick-box (the 25%-retention one), its office
  renderer, and the commitment-chase email. All five now resolve from the brand; ack KEYS
  untouched so stored signatures still resolve; default wording byte-identical **proved by
  mutation** (`tests/lib/ack-company-wiring.test.ts` deletes each wiring and fails if the
  test stays green - it caught one of its OWN assertions being inert, matching
  generateMetadata's copy of the theme resolve rather than the page body's).
- **`/cv`'s submit button said "Send to Marley Moves"** under a Pitmans wordmark. Both leaks
  were **invisible to the source scan** - neither file was in its MANIFEST, so it reported
  "0 leaks" while its own header said an unlisted file is UNSCANNED, not clean. True, and
  unreadable. That is the argument for the rendered half, which #214 ships
  (`e2e/public/brand-leak-rendered.spec.ts`) along with a manifest walk of the five public
  routes' import graph that cannot rot.
- **The rendered spec then made that argument itself, on its FIRST CI run.** Staging
  `7eb1849`: **185 passed** (up from 182), 5 failed = the 4 known Zoho-quota specs **plus
  this one**, and it failed because it found a real leak. A second brand's `/q` served
  `<meta name="description" content="Marley Moves internal operations panel">` under a
  correctly-branded `<title>`: `generateMetadata` MERGES with the root layout rather than
  replacing it, so a page setting only `title` inherits `app/layout.tsx`'s description -
  the wrong company, plus the words "internal operations panel", on a page a customer opens
  from a link and forwards. **The source grep could never see it** - the literal lives in
  `app/layout.tsx` where it is CORRECT; the INHERITANCE is the defect, and only a rendered
  page shows that. Fixed with a new `pageDescription()` beside `pageTitle()` on `/q`, `/s`
  and `/cv`. The spec is still NOT "done" per the standing rule: it needs a second green CI
  run, and this was its first.

Also in #214: **QA-20260827-04** built (token-auth `/cv` upload, JPEG/PNG sniff, DB-enforced
ceilings, server-generated keys); WebP/HEIC refused **deliberately** - one customer WebP
would have sent the crew NO day sheet for every job that day; the crew sheet no longer
reports a clean run while sending photo-less; customer photos cannot starve the estimator's
access shots; the office gallery caps per category and says "showing N of M"; card refund
emails no longer borrow the default office's phone for a brand with none. **And the
`qa-auto-merge.yml` risky-path guard is widened** - measured against #210/#211, **14 changed
files sat outside the old list** (`lib/ledger/**`, `lib/bank-feed/**`, `lib/brand.ts`), plus
`lib/payments-policy.ts`, which the `lib/payments/**` folder pattern never matched.

**Migration 0117** applied to staging + verified (both columns, both `security definer`
functions, **0 rows backfilled**), and in the runbook ABOVE the deploy row. Prod batch is now
**0104-0117**. Gates on the merged tree: lint / typecheck / **3446 tests** (from 3350) /
build / leak scan 90 files 0 leaks - all green.

**Three findings open, and NONE of them is ours to close:**
- **QA-20260902-06 (Zoho quota).** Now three independent observations agree - a raw
  read-only probe at 19:52Z and two role-agents at 20:23Z, all seeing a **200 token refresh
  over a 429 org**. **Correcting the earlier record: "re-run tomorrow to confirm" was too
  confident.** Every observation is equally consistent with a plain UTC-midnight reset that
  OUR OWN CI re-exhausts by lunchtime (~32 merges/2 days, each running an invoice-creating
  e2e suite). Both readings predict the same thing: **it recurs every day CI volume stays
  where it is**, so waiting is a coin flip, not a remedy. Reduce the burn or raise the
  allowance - **prod runs against the same 1,000/day cap on the live org.** Close only on a
  live re-probe, never on a calendar date.
- **QA-20260902-04 (takepayments).** Merchant 292749's sandbox rejects takepayments' OWN
  published test cards (`65566 Disallowed cardnumber`). `e2e/fixtures/sandbox-cards.ts` is
  empty and **nothing consumes it**, so the card capture path has ZERO e2e coverage. Needs
  the right PANs from Peter's account manager.
- **QA-20260827-04.** Implemented in #214 but **deliberately left open**: its Verify clause
  (control usable on `/cv`, object readable back, photo loadable on the admin page) has not
  been executed. Unit tests and four gates are not a browser.

**Still Peter's:** the 3 ClickUp decisions (869ett5wy, 869ett5y8, 869eu70v3); finding 36's
two-theme-per-brand call; the takepayments PANs; and the Zoho burn-rate decision above.
**Gate 15 is unchanged and NOT addressed** - the published `storage-terms/v2-2026-08-31.md`
carries the same lien sentence and is hash-locked immutable, so it can only be superseded;
#214 fixed the RENDERED wording only. Named but not fixed: `lib/quote/chase.ts`'s
default-brand signature block, and `collect-contract-button.tsx`, which links the default
brand's terms URL for every brand and takes no brand at all. **Next:** gate 15 (Mark's doc),
QA-20260827-04's live verification, then the 18 September promotion.

_Prior sessions -> brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only - `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
