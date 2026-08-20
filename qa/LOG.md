# QA audit run log

Append-only, newest first. One entry per run: timestamp · sha audited · verify-first results · items tested per agent · findings filed / specs added · pushes · cleanup verification counts · time spent.

---

## 2026-08-20T00:26Z–00:37Z — repair run (first-pass, Fable, push-triggered): 1 finding fixed, PR #25 opened

- Tier: first-pass. Base: `9f42bd1` (origin/staging at checkout).
- Findings taken: QA-20260820-01 (safe-fix, medium — staging CI e2e job can hang 6h with no `timeout-minutes`, wedging the deploy-staging concurrency group and silently skipping the prod-promotion gate) — claimed, fixed on `qa-repair/QA-20260820-01`, finding updated to `fixed-pending-verify` in the branch.
- Fix: `timeout-minutes` on every job in all four workflows (staging 15/20/45, deploy 15/20, qa-auto-merge 20/10, qa-findings 10); `tests/config/workflow-timeouts.test.ts` line-parses the workflows and enforces the invariant repo-wide (verified failing 4 files/8 jobs pre-fix). Playwright browser caching deliberately skipped — not needed to kill the failure scenario. Gates: lint 0 · tsc 0 · vitest 1694 · build green.
- PRs opened: [#25](https://github.com/redbananastudios/marley-ops/pull/25) → staging, labelled `qa-repair`.
- Escalations: none. Not taken: QA-20260819-01, QA-20260820-03, QA-20260820-04 all `class: risky` (untouched per scope rules); QA-20260820-02 `status: fixing`, owned by a concurrent run.
- Time spent: ~11 min.

## 2026-08-19T13:30Z–13:45Z — repair run (first-pass, Fable): 1 finding fixed, PR #20 opened

- Tier: first-pass. Base: `fa3c5ba` (origin/staging at checkout).
- Findings taken: QA-20260819-02 (safe-fix, e2e cubic-survey seed shape) — claimed, fixed on `qa-repair/QA-20260819-02`, finding updated to `fixed-pending-verify` in the branch.
- Fix: seed items extracted to `scripts/seed-e2e-fixtures.mjs` as a spec-correct `CubicLine` (real catalogue entry `living-space:sofa-2-seater`); contract test `tests/scripts/seed-e2e-cubic-items.test.ts` pins the literal to `sanitizeCubicLines` + the catalogue (verified failing 3/3 on the old shape). Gates: lint 0 · tsc 0 · vitest 1686 · build green.
- PRs opened: [#20](https://github.com/redbananastudios/marley-ops/pull/20) → staging, labelled `qa-repair`.
- Escalations: none. QA-20260819-01 is `class: risky` (shared-client contact overwrite) — untouched per scope rules, awaits a human/risky-tier route.
- Time spent: ~15 min.

## 2026-08-19T12:00Z–12:50Z — first full run: 2 findings filed, 1 spec added

- sha audited: 66d75f1 (origin/staging, HEAD at checkout) — deployed staging matched the last code-bearing commit `e1eeb1c` (`curl /api/version` → `e1eeb1c`, CI+Deploy run 83 green); the two commits between it and HEAD were prior run's log-only entries, no code change, so no pending deploy to wait on.
- Credential check: all three (`QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY`, `QA_STAGING_CRON_SECRET`) present.
- Health gate: staging reachable (200, sha matched). Four local gates on the untouched tree: lint 0 errors/36 pre-existing warnings · tsc 0 · vitest 1673 passed/7 skipped · build clean.
- Verify-first: `qa/findings/open/` was empty (first real run) — nothing to re-verify.
- Seed: swept 0 leftover `QA-SENTINEL` rows (clean slate), minted 3 throwaway users (admin/estimator/crew, random passwords) + 1 marker client+lead+accepted-quote fixture.
- Rota: dispatched one subagent per role (admin, estimator, crew, customer), each ~30 min budget, each proving own-UI → SQL read-back → (where applicable) the other role's UI, plus two-hats/IO-proof/truth-of-UI lenses throughout.
  - **Admin**: 10 of 12 planned ops run (lead create/edit, lead lost/no-reply, quote-build-draft, survey book/reschedule/cancel, removal book/changedate/cancel, staff add/edit, claims full lifecycle, documents review, settings view-only) — deposit/balance-paid and refunds-queue not reached (time budget); bank-feed attach/link/unlink correctly skipped (no safe marker-only row). 1 finding (below).
  - **Estimator**: 12/12 ops PASS incl. the two security-critical checks — `/finance`, `/finance/statements`, `/refunds` all correctly bounce an estimator login, nav never exposes those links. 0 findings.
  - **Crew**: 22/22 ops PASS incl. a targeted re-probe of the historical hours/notes-nulling bug (edit round-trip correctly preserves untouched fields) and IO proof on two storage buckets + the job-sheet PDF (`%PDF` magic bytes). 0 findings.
  - **Customer**: 12 of 15 planned ops run (`/q` accept + deposit self-report + Zoho invoice self-heal — card payment correctly SKIPPED, `card_payments_enabled=false` kill switch confirmed off, not ambiguous; `/cv` submit; `/s` sign with full legal-snapshot proof — `terms_version`/`terms_sha256`/full snapshot text captured; `/sheet` render; bad-token 404s ×3). `/join` skipped per scope. 1 finding (below).
- Findings filed: **QA-20260819-01** (`risky`, medium — a lead's Contact card reads the shared client's name/phone/email/postcode instead of the lead's own, and editing one lead silently overwrites those fields on the client for every other lead sharing it; verified against source + live SQL reproduction), **QA-20260819-02** (`safe-fix`, low — `scripts/seed-e2e.mjs`'s cubic-survey fixture writes an item shape `CubicLine` rejects, so a customer can never submit a survey seeded that way; verified by reseeding with the correct shape and confirming submit then succeeds).
- Specs added: `e2e/estimator/gating.spec.ts` gained the `/refunds` case (verified live this run, matches the file's existing `/finance`/`/finance/statements` pattern exactly, source-confirmed redirect target); `e2e/COVERAGE.md` updated in the same commit. Several other verified-PASS flows (crew full journey, admin survey book/reschedule/cancel, customer accept+sign mutations) came back from the role agents as working script drafts but were not converted to permanent specs this run — left for a future run to avoid shipping unreviewed Playwright against a live TLS/proxy workaround this environment needed (see below).
- Environment note for future runs: Chromium's default TLS 1.3 ClientHello gets reset by this sandbox's egress proxy; every role agent independently found the fix (`--ssl-version-max=tls1.2`, plus proxying/cert-trust flags). Worth folding into `playwright.config.ts` or documenting explicitly in `qa/AUDIT.md` so a future run doesn't spend its budget rediscovering it.
- Push: `a0528d7` on `staging` (findings + spec + `qa/state.json` + `e2e/COVERAGE.md`), rebase clean (no upstream changes), this log entry pushed separately.
- Cleanup verification (all zero, by query, after fixing an appointments↔surveys FK-cycle wrinkle and two profile-referencing tables — `communications.sent_by`, `events_log.actor_id` — that blocked two auth-user deletes on the first pass): leads 0 · clients 0 · quotes 0 · appointments 0 · staff 0 · storage_sites/units/lets 0 · cubic_surveys 0 · crew_job_sheets 0 · profiles 0 · auth users 0.
- Time spent: ~50 min wall clock (setup/gates ~15 min, 4 role agents in parallel background ~30 min longest, triage/spec/ledger/cleanup/push ~20 min) — over the 45 min soft budget, under the 60 min abort; the overrun was mostly agents independently diagnosing the same TLS proxy issue, now documented above for next time.

---

## 2026-08-19 — run skipped: missing staging credentials

- sha audited: e1eeb1c (origin/staging, HEAD at checkout)
- Verified all three required env vars per AUDIT.md step: `QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY`, `QA_STAGING_CRON_SECRET` — **all three missing** from the environment.
- No testing performed, no findings filed, no specs added, no cleanup needed.
- Did not improvise credentials from any other source. Stopping cleanly per instructions.
- Time spent: <5 min (credential check only).

---

## 2026-08-19 — run aborted: staging domain blocked by network egress policy

- sha audited: 4498b07 (origin/staging, HEAD at checkout)
- Credential check per AUDIT.md step: `QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY`, `QA_STAGING_CRON_SECRET` all present.
- Health gate: `curl https://staging.ops.marleymoves.co.uk/api/version` failed — proxy returned `CONNECT tunnel failed, response 403`. Confirmed via `$HTTPS_PROXY/__agentproxy/status`: `recentRelayFailures` shows `connect_rejected` / "gateway answered 403 to CONNECT (policy denial or upstream failure)" for `staging.ops.marleymoves.co.uk:443`. Cross-checked with the WebFetch tool, which returned `EGRESS_BLOCKED` for the same domain — a second, independent path confirming this is a non-transient organization egress policy denial, not a flaky connection. Per the proxy's own guidance (`/root/.ccr/README.md`): "do not retry or route around it — report the blocked host."
- This session's network policy does not allow reaching the deployed staging site at all, which the entire audit (health gate, all four role agents, all handoff scenarios, Playwright specs) depends on. No DB seeding, no browser testing, no findings filed, no specs added — nothing was attempted beyond the connectivity check, per the abort conditions ("staging unreachable").
- No marker rows were created, so no cleanup is required.
- No code/spec changes beyond this log entry; pushing to `staging` only.
- **For Peter:** this run's environment (the scheduled/cloud host running this session) needs `staging.ops.marleymoves.co.uk` allow-listed in its egress policy, or the QA schedule needs to run from a host whose policy already allows it (e.g. i9), or the audit can't execute.
- Time spent: <10 min (credential + connectivity check only).

---

## 2026-08-19 — first-pass repair sweep (scheduled): no eligible findings — QA-20260819-01 is class: risky (not touched), QA-20260819-02 already fixed-pending-verify (PR #20, landed on staging as 6f6a8dd, awaiting next audit verify). Nothing claimed, no branches, no PRs.

---

## 2026-08-20 — overnight deep run: truth-of-UI SQL diffs + cron IO proof + verify-first close

- sha audited: d00bf0d (origin/staging HEAD; deployed /api/version = 438dcb5 — differs only by the qa-log-only commit, no app-code delta; the 438dcb5 CI run's e2e job was found HUNG, see QA-20260820-01).
- Verify-first: QA-20260819-02 re-run live and CLOSED — fresh QA-SENTINEL cubic fixture seeded with the repaired CUBIC_SURVEY_SEED_ITEMS literal; /cv submit succeeded end-to-end (UI success message; SQL: status=customer_submitted, items 1→2 all spec-correct CubicLine, total_ft3=60 recomputed; seed-e2e.mjs confirmed importing the shared literal). QA-20260819-01 (risky) untouched, stays open for Peter.
- Health gate: lint 0 errors · tsc 0 · vitest 1689 passed/7 skipped · build ok — all green on the untouched tree.
- Seed: swept 0 leftover QA-SENTINEL rows (clean slate), minted 3 throwaway users (admin/estimator/crew, random in-memory passwords) + marker client+lead+accepted-quote (QA-SENT-20260820-1, £1,400, used as a queue tracer) + cubic verify fixture.
- Items tested: customer/cv_self_fill_survey PASS (live submit) · io/cron_13_routes PASS 2/13 (ai-jobs + comms-retry: 200, honest ok cron_runs rows, zero-summaries proven true zeros by queue SQL) · truth/payments_tabs_totals + truth/bookings_money_queues + truth/dashboard_counts_badges: EVERY rendered number matched service-role SQL recomputation exactly (Received/Due/Upcoming tabs, all 7 bookings queues incl. tracer, all 12 dashboard tiles/KPIs) — but three definitional-honesty findings below · spec_gaps/office_jobs_spec CLEARED.
- Findings filed: QA-20260820-01 (safe-fix, medium — staging.yml e2e job hung 3.5h+ on `npx playwright install`, no timeout-minutes on any job, wedging the deploy-staging concurrency group and silently skipping the prod-promotion e2e gate on CSP-uploads commit 438dcb5) · QA-20260820-02 (safe-fix, medium — dashboard "Awaiting deposit"=1 vs /bookings deposit queue=6, tile counts status='provisional' while its own comment claims it mirrors /bookings) · QA-20260820-03 (risky, medium — "SURVEYS BOOKED 2 · 100%" with zero survey appointments in the DB; isSurveyed inferred from STATUS_RANK) · QA-20260820-04 (risky, medium — single-bucket classifyBooking hides a move-day £1,700 unpaid balance behind its unpaid £100 deposit: "Owed right now £600" vs Upcoming "£5,100 this week" vs /bookings "Balance outstanding £0" for the same jobs).
- Specs added: e2e/office/jobs.spec.ts (Completed Jobs — render, search-by-quote-ref narrows to seeded job, no-match empty state) — validated green against deployed staging with this run's minted users; e2e/COVERAGE.md updated.
- Log-only observations (no finding): /cv success panel renders "(2items)" without the space though source (cubic-builder.tsx:353) is correct — deployed-bundle whitespace artifact, re-check next deploy · staging bank feed last synced 2026-08-06 yet sits under a green "every transfer is matched" all-clear with no staleness threshold (staging cron presumably off; the honesty question may deserve a finding if seen on prod-shaped data).
- Pushes: 9f42bd1 (findings close/file + spec + COVERAGE) then this commit (3 truth findings + state.json + log) — staging only, no PRs, master untouched.
- Cleanup verification (all zero, by query): leads 0 · clients 0 · quotes 0 · appointments 0 · cubic_surveys 0 · staff 0 · storage_lets/units/sites 0 · profiles 0 · activities(marker leads) 0 · auth users 3/3 deleted.
- Time spent: ~40 min wall clock (gates ~12 min background; 2 role agents in parallel ~10/~13 min; main-loop cron proofs, CI-hang investigation, spec, findings, cleanup).

---

## 2026-08-20 — escalation repair sweep (scheduled): nothing escalated — no open finding carries `escalate: opus-5` (QA-20260820-01/-02 are `status: fixing`, owned by in-flight first-pass runs; QA-20260819-01, QA-20260820-03/-04 are `class: risky`, never in scope). Nothing claimed, no branches, no PRs. Time spent: ~5 min.

## 2026-08-20 — first-pass repair (push-triggered, cc2473d): took QA-20260820-02 (dashboard "Awaiting deposit" tile counted `leads.status='provisional'` vs /bookings' deposit_outstanding queue — 1 vs 6 on staging). Fixed on `qa-repair/QA-20260820-02`: both money tiles now count off the shared /bookings ledger (`loadBookingRows` + new pure `moneyTileCounts` in lib/bookings/queue.ts), replacing the tile's status proxy AND the page's hand-rolled, unpaginated balance-due reimplementation. Test `tests/lib/dashboard-money-tiles.test.ts` (unit + source contract, verified fails pre-fix). Gates: lint 0 · tsc 0 · vitest 1694 · build. PR [#26](https://github.com/redbananastudios/marley-ops/pull/26), labelled qa-repair. Skipped: QA-20260820-01 (status: fixing, owned elsewhere), QA-20260819-01/QA-20260820-03/-04 (class: risky). No escalations. Time spent: ~12 min.
