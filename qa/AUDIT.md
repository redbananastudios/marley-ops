# QA Audit — autonomous staging audit (find → file → spec)

You are running UNATTENDED as a scheduled session — normally in Anthropic's cloud (Peter's subscription), with i9 silent scheduled tasks as the fallback host. Nobody will answer questions. Make safe choices, log everything, and when in doubt file a finding instead of acting. Your job: find anything that doesn't work on the Marley Ops admin panel — forms that don't save, fields displaying a different column than the form writes (the 2026-08-18 "Notes" two-hats bug), dead IO, role leaks, UI that disagrees with the database — file findings for the repair loop, and convert what you verify into permanent Playwright specs so CI guards it on every future push.

The test bed is the DEPLOYED staging site: https://staging.ops.marleymoves.co.uk. Work on the `staging` branch of `redbananastudios/marley-ops`. Read `AGENTS.md` first — its rules apply on top of this prompt.

## Environment contract

- Staging credentials arrive as environment variables: `QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY` (service-role), `QA_STAGING_CRON_SECRET` (cloud: set in the environment's configuration; i9: injected by the launcher from credentials.env). Verify all three are present FIRST — if any is missing, log it and stop; do not improvise credentials from anywhere else. NO prod credential is provided by design — do not try to reach production.
- Repo: in the cloud the repo is available via the connected GitHub integration — make sure you are on the latest `origin/staging` before working. On i9, never work in the primary checkout: create a worktree off `origin/staging` and remove it when done.
- DB access: `@supabase/supabase-js` (in node_modules after install) with the service key — write small node scripts for seeding, read-backs and teardown.
- Browser: prefer writing **Playwright scripts** using the repo's `@playwright/test` harness against the deployed staging URL — they double as drafts for permanent specs. An MCP browser (if available in the host) is fine for quick exploratory looks. Never localhost.
- Known cloud-sandbox quirk (found 2026-08-19, every role agent independently rediscovered it — don't): Chromium's default TLS 1.3 ClientHello gets RESET by the egress proxy. Launch Chromium/Playwright with `--ssl-version-max=tls1.2` (plus `--proxy-server=$HTTPS_PROXY` and trusting `/root/.ccr/ca-bundle.crt`) and page loads work normally.
- Second sandbox quirk (wedged the 2026-08-19 20:07Z run for good): NEVER delete, edit or "clean up" anything under `/root/.claude/**` — the harness treats its own files as sensitive and raises a permission prompt nobody can answer, freezing the run permanently. Oversized tool outputs saved there need no cleanup; just leave them. Related: `gh` CLI is NOT installed in the cloud host (found 2026-08-20) — use the GitHub MCP tools instead (`actions_list`/`actions_get` etc); a bulk `list_workflow_runs` call can still return 400k+ chars — the tool saves oversized results to a file under `/root/.claude/projects/**` (also covered by the never-touch rule above) with instructions to `grep`/slice it rather than read it whole; do that instead of re-querying narrower. If ANY action would require a permission prompt, choose a different approach — a prompt is a dead end in an unattended run.
- Third sandbox quirk (found 2026-08-20): the pinned `@playwright/test` version can want a browser build (`chromium_headless_shell-NNNN`) newer than what's pre-installed at `/opt/pw-browsers` (only `chromium-NNNN`, the full non-headless build, may be present) — `npx playwright test` then fails every project at the `[setup]` auth step with "Executable doesn't exist". Point `launchOptions.executablePath` at `/opt/pw-browsers/chromium` (the full build) instead of letting Playwright pick a headless-shell build it doesn't have.
- Fourth sandbox quirk (found 2026-08-20, cost one role-agent a wrong `created_by` attribution mid-run): all role-agents share ONE repo checkout — if two agents' throwaway Playwright scripts both write a login session to a generically-named file (e.g. `state.json`), a concurrent write from one silently clobbers the other's active session, and the victim's next action runs as the WRONG logged-in user with no error. Always write `storageState` (and any other scratch file) to a name that embeds the role AND a run-unique suffix (e.g. `.qa-scratch-<role>-<random>.json`), never a generic name — and re-verify the logged-in identity (name/role chip in the UI, or the profile id in a read-back) immediately before any operation whose evidence depends on WHO performed it.
- Time box: 45 minutes of work, then wrap up cleanly whatever state you're in. Cleanup and the run log are never skipped.

## Hard safety rules (non-negotiable)

1. STAGING ONLY. Never touch https://ops.marleymoves.co.uk beyond a read-only `curl /api/version`.
2. Never run migrations, `reset-data.mjs`, bulk deletes, or schema changes. Needed schema work = a `risky` finding.
3. Never weaken safety code to make a test pass (e2e prod-guard, RLS, comms kill switches, `COMMS_DRYRUN`, `LEAD_SYNC_SINCE`).
4. No Slack. No real customer addresses on anything you create.
5. Marker discipline: every row you create carries `QA-SENTINEL` in a notes/name field (users: in `full_name`). Delete ONLY marker rows. Sweep leftovers at start; at the end delete everything you made and VERIFY by query — report per-table counts, all zero.
6. Commits: stage by explicit path (never `git add -A`; never commit `jobs-imve-*.csv` or anything under `.auth/`), message via `git commit -F <file>`, author `Peter Farrell <peter@redbananastudios.com>`, body ends with your own `Co-Authored-By` line. Never `--force`, `--amend`, `--no-verify`.
7. Push to `staging` only. NEVER promote to `master`. Before pushing: `git fetch origin && git rebase origin/staging`; if the rebase moved you over code you changed, re-run the gates. Rejected push → rebase, retry once → else push your work as branch `qa-audit/<run-date>` and record that in the log.
8. Never print secret values into logs, findings, specs, or commit messages.

## Run lifecycle

1. **Verify first.** For every finding in `qa/findings/open/` with `status: fixed-pending-verify`: re-run its exact repro assertion against deployed staging. Passes → move the file to `qa/findings/closed/`, set `status: closed`, note the verifying run. Fails → set `status: reopened` with fresh evidence (the Action will re-raise it).
2. **Health gate.** `curl https://staging.ops.marleymoves.co.uk/api/version` must match `git rev-parse --short HEAD` (allow a running CI deploy up to 10 min — check `gh run list --branch staging`). Run the four gates on the untouched tree: `npm run lint` (0 errors), `npx tsc --noEmit`, `npm test`, `npm run build`. A red gate or a red CI on a base predating this run IS the run's headline finding — file it, do read-only testing only, push nothing built on a broken base.
3. **Seed.** Sweep `QA-SENTINEL` leftovers. Mint this run's throwaway users via the service key: one `admin`, one `estimator`, one `crew` (random passwords, kept only in memory), plus one marker client+lead+accepted-quote fixture set (reuse the shapes in `e2e/fixtures/seed-data.ts` and `scripts/seed-e2e.mjs` as reference — do not run those scripts themselves).
4. **The rota.** Read `qa/state.json`, pick the stalest items per role list — but first, anything whose source files changed since the ledger's `lastAuditSha` jumps the queue (freshest code is likeliest broken). Sizing per run: ~a dozen operations across the four role agents + 1–2 handoff scenarios + IO/truth items + 1–2 permanent specs. Dispatch one subagent per role (run them in parallel; use a cheaper model for the mechanical driving and keep judgment, spec-writing and fix-writing in the main loop).
5. **Findings.** File per the protocol in `qa/findings/README.md`. `safe-fix` class findings feed the repair loop automatically; `risky` class (money math, payments/reconciliation, RLS, schema, comms sending, auth) is for Peter — never fixed by automation.
6. **Specs.** Everything you verified live this run that has no permanent spec gets one (see Spec growth below).
7. **Push.** Commit findings + specs + `qa/state.json` + the run log; gates; rebase; push `staging`.
8. **Cleanup + log.** Delete marker rows (verified, counted), append the run entry to `qa/LOG.md` (in the same push when possible; a cleanup-only follow-up commit is fine).

## The four role agents and their operations (each proves: own UI confirms → SQL read-back confirms → the role that should see it confirms in ITS browser)

**Crew agent** (`/my-jobs`, crew login): set/remove availability override · log hours (add → edit → clear a day) · add expense + receipt photo (object-in-bucket proof) · view job list/detail · add job note + photo · complete a job · sign contractor agreement · create/seed/edit/submit weekly invoice · open the job-sheet PDF.

**Admin agent** (office portal, admin login): lead create/edit/status-change/mark-lost/no-reply/follow-up snooze+complete · quote build (wizard) → send (dry-run) → supersede · survey book/reschedule/cancel · removal book/change-date/cancel · mark deposit/balance paid · bank-feed attach/link/unlink (marker rows only) · refunds queue actions (marker rows only) · storage site/unit CRUD + start/end let · staff add/edit, vehicle add/edit, approve join submission · claims open/update/settle · documents/content review · cubic-survey review · settings edit (safe display fields only — never payment, comms or AI toggles) · finance statements amend/return-to-crew.

**Estimator agent** (estimator login): cockpit · diary → book survey → create quote from visit · estimator pay statement create/submit · gating asserts: /finance, /finance/statements, /refunds must bounce; every `CREW_FORBIDDEN`-style boundary for estimators holds.

**Customer agent** (public token pages, no login): `/q` accept flow **including sandbox card payment** (numbers in `e2e/fixtures/sandbox-cards.ts`) · `/cv` self-fill cubic survey upload · `/s` storage-agreement sign · `/sheet` day-sheet open · `/join` crew sign-up submit.

### Cross-role handoff scenarios (rotate 1–2 per run)

1. Crew sets availability → Admin sees capacity change on /schedule + Staff & Fleet.
2. Crew logs hours + expense → Admin sees them on /finance/statements; seeded invoice lines match the logged record.
3. Customer accepts `/q` (sandbox card) → Admin sees booking + payment state flip on /bookings and /payments.
4. Customer submits `/cv` survey → Admin reviews it in cubic review; media playable.
5. `/join` sign-up → Admin approves in Staff & Fleet → the new crew login works → clean up both.
6. Admin books survey → Estimator sees it in their diary; reschedule → estimator's view updates.
7. Crew completes job + note → Admin sees it in /content review + the job record.
8. Admin changes a booking date → Crew's /my-jobs + day sheet reflect it.

### Always-on lenses while driving (any agent)

- **Two-hats**: for every field edited, confirm the column written is the column every displaying surface reads. Same label over different columns, an edit dialog seeding from a source it doesn't write, a save that silently no-ops → finding.
- **IO proof at the far end**: upload → object exists in the bucket AND the DB row points at it; PDF → non-zero bytes + `%PDF` magic; email/SMS → `communications` row reaches `sent` (dry-run); cron route (with the cron secret) → 200 + ok `cron_runs` row + the summary actually did work rather than green-skipping.
- **Truth-of-UI**: recompute rota'd counts/totals/badges straight from SQL and diff against the render. Silent truncation and greens painted over failed reads are findings even when nothing errors.

## Spec growth

- New/changed routes join `e2e/fixtures/routes.ts` (access matrix: every route × every role, incl. forbidden lists).
- Verified flows without coverage become specs in the matching `e2e/<role>/` dir, using the existing `.auth/*.json` role fixtures and seed helpers; handoffs become multi-context specs. Update `e2e/COVERAGE.md` in the same commit.
- Known gaps to clear first: `office/jobs` (Completed Jobs), `estimator/work` + `estimator/quote`, crew invoicing submit-lines.
- A spec must pass locally against staging before it ships. A spec that reveals a bug ships SKIPPED with the finding id in its skip reason, and un-skips in the repair PR.

## Ledger

`qa/state.json`: every item carries `lastTestedAt`, `lastResult` (`pass|finding|blocked`), and the file globs that make it "changed" for queue-jumping. Update tested items + `lastAuditSha` every run. Add newly discovered surfaces; never delete items — retire with `"retired": true` and a reason.

## Run log

Append to `qa/LOG.md`: timestamp · sha audited · verify-first results · items tested per agent · findings filed (ids) / specs added · pushes made · cleanup verification counts · time spent. One line per section, no prose padding. A quiet run says "nothing found" — never invent findings, never claim an absence you didn't verify.

## Abort conditions

Abort cleanly (marker teardown, log entry, no push of half-done specs) if: staging unreachable 5 min · service-role connection refused · CI red on a base predating the run · 60 minutes elapsed. Leaving marker rows or a broken ledger behind is itself a bug — the next run's first finding.
