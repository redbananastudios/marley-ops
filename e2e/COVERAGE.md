# Marley Ops — E2E coverage matrix

Goal: **every function and feature, for every role, driven via Playwright.** Built
in waves against the staging-wired dev server (`ZOHO_ORG_ID` = Demo Removals, never
live). Status: ✅ done · 🟡 partial · ⬜ todo.

Specs live under `e2e/<role>/*.spec.ts` (picked up by the matching project). Shared
route lists in `fixtures/routes.ts`; helpers in `fixtures/ui.ts` + `fixtures/zoho.ts`.

## Access & gating (the regression net)
| Coverage | Status | Spec |
|---|---|---|
| Admin — every office route loads (27) | ✅ | office/access.spec.ts |
| Crew — /my-jobs routes load (5) + bounced off 10 dashboard routes | ✅ | crew/access.spec.ts |
| Estimator — every nav route loads (11) | ✅ | estimator/access.spec.ts |
| Estimator — /finance, /finance/statements, /refunds, / redirect | ✅ | estimator/gating.spec.ts |
| Estimator — /board, /jobs, /clients, /storage, /performance, /automations, /documents also redirect | ✅ | estimator/gating.spec.ts — QA-20260827-01 (these 7 pages had NO role gate at all, live on staging AND master) is fixed: each calls `requireAdminPage()` as its first statement and the 7 assertions run unskipped. `tests/config/dashboard-route-gates.test.ts` is the mechanical half — it re-derives each gate from the page source, so a new ungated dashboard route fails `npm test` rather than waiting for an e2e run |

## Office / admin features
| Flow | Status | Spec |
|---|---|---|
| Dashboard — period tabs, needs-action cards | ✅ | office/dashboard.spec.ts |
| Leads — presets, search, add-lead create → detail | ✅ | office/leads.spec.ts |
| Lead detail — stepper + tab switching | ✅ | office/lead-detail.spec.ts |
| Follow-ups — mark done with an outcome | ✅ | office/follow-ups.spec.ts |
| Mark lost — reason-gated loss flow | ✅ | office/mark-lost.spec.ts |
| Quotes — list presets, search, open | ✅ | office/quotes.spec.ts |
| Quote builder wizard — new quote → 7-step wizard → send dialog | ✅ | office/quote-builder.spec.ts |
| Quote ref mints the lead's own brand prefix (PM for pitmans, not MM) | 🟡 | office/quote-brand-ref.spec.ts — proven live 2026-08-25 by the admin role agent + independently reproduced by the main loop at the RPC level (`next_quote_ref` already supports `brand`, the app just never passes it); ships `test.skip`'d with the open finding QA-20260825-03, un-skips in the repair PR |
| Quote PDF filename carries the quote's brand (gate 14, `Pitmans-Quote-<ref>.pdf` / `MarleyMoves-Quote-<ref>.pdf`) | ✅ | office/quote-pdf-brand.spec.ts — passed locally against staging 2026-08-26 (2/2, ~14s). Filename-prefix + two-hats only; the deeper PDF colour/text brand checks (Pitmans blue `#2B2B76`, legal line, shared bank details) were proven live by a role agent this same run but have no permanent spec — no PDF-text-extraction dependency exists in this repo yet |
| Bookings — sections, mark-paid dialog (balance = P0#1) | ✅ | office/bookings.spec.ts + p0-money |
| Payments — day view, stat sections | ✅ | office/payments-finance.spec.ts |
| Commercial payments ladder: no-deposit lead card + undated completion invoice on Upcoming | 🟡 | office/payments-commercial-ladder.spec.ts — added 2026-09-01 QA audit (freshness override, PR #182's commercial-deposit-cell fix + the "Commercial, not yet dated" Upcoming card, neither previously covered by e2e). Both role-agent-live-verified against staging with SQL cross-checks (0 findings — see qa/state.json admin.mark_deposit_balance_paid, truth.payments_tabs_totals) and separately re-confirmed by the main loop: a manual throwaway-login Playwright script hit the exact same seed shape and locators this file uses, both matched exactly once against the live DOM. `test.skip`'d: this env has no `E2E_OFFICE_PASSWORD` — tsc/eslint clean, `playwright test --list` loads it under office (2 tests) — same standing gap as every other DB-seeded admin spec, not blocked by any bug |
| Handoff h3: customer accepts /q (bank transfer) → office sees the deposit-pending booking on /bookings AND /payments?tab=due | 🟡 | office/customer-accept-to-bookings.spec.ts — added 2026-08-29 QA audit, closing a gap open since the handoff list's inception. Proven live against staging by the main loop's own scratch runner using a freshly minted throwaway admin login (own seed/browser contexts/read-back) before shipping — both the customer-accept leg and the office read-back matched the DB exactly, 0 findings. `test.skip`'d: this env has no `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` so `E2E_DB_READY` is false — the file itself has never executed via the real Playwright runner here, same standing gap as every other DB-seeded spec, not blocked by any bug |
| Finance — Invoices & VAT / FRS (reads staging Zoho) | ✅ | office/payments-finance.spec.ts |
| Bank feed — whole-quote link (deposit+balance settled in one transfer) | ✅ | office/bank-feed-whole-quote.spec.ts |
| Invoice resend vs the legacy iMVE comms lock (deposit/commitment locked, balance deliberately not) | 🟡 | office/invoice-resend-lock.spec.ts — closes `admin_invoice_resend_lock_spec`. Underlying flow proven live 2026-08-26 by the QA audit's admin role-agent (both branches, real browser, SQL read-back); this file's own seed shapes/locators were separately verified against `lib/legacy.ts`, `lib/quote/accept-flow.ts` (`resendDepositInvoiceFlow`/`resendBalanceInvoiceFlow`), `components/leads/{resend-invoice-button,balance-invoice-button}.tsx`, tsc/eslint clean, `playwright test --list` loads it under office (2 tests). `test.skip`'d: this env has no `E2E_OFFICE_PASSWORD` so `auth.setup.ts` can't sign in the office fixture — the file itself has never executed here, same standing gap as every other DB-seeded spec — not blocked by any bug |
| Contractor pay — return a submitted invoice | ✅ | office/contractor-pay.spec.ts |
| Schedule — survey + removal diary, new-appt dialog | ✅ | office/schedule.spec.ts |
| Schedule — existing-appointment VIEW dialog (crew/vans, job notes two-hats, price-free) | ✅ | office/appointment-view-dialog.spec.ts |
| Schedule — gate-11 diary brand layer (brand-derived fills, hollow-unconfirmed → solid flip on `date_confirmed_at`, survey-always-solid accent fill, brand initials, legend) | ✅ | office/diary-brand-layer.spec.ts — every assertion validated live against deployed staging by the 2026-08-26 overnight audit (a byte-identical scratch runner of the spec's seed/locators/assertions/teardown: 20/20 ok incl. teardown-to-zero) before shipping; guarded by `E2E_DB_READY`, runtime-skips if <2 active brands |
| Job Board (embedded in /schedule?tab=alloc "Day Allocation" as JobBoardView) — resources rail, week nav, assign-staff/vehicle modal | ✅ | office/job-board-view.spec.ts — added 2026-08-29 QA audit: self-seeds/tears-down its own marker client/lead/appointment (looks up an already-active staff+vehicle pair rather than seeding new roster rows), asserts resources-rail row counts match SQL active-counts, week-nav round trip, and the assign modal writing appointment_assignments (SQL read-back + post-reload chip render). Validated green against staging twice in a row (via `npx playwright test --project=office`, a temporary QA_SANDBOX-gated launchOptions patch reverted before commit) before shipping; guarded by `E2E_DB_READY` |
| Board (/board) — pipeline kanban by stage | ✅ | office/board-kanban.spec.ts — added 2026-08-27 QA audit: self-seeds/tears-down 3 marker leads at website_enquiry/quoted/confirmed, asserts each renders in its matching column and the column counts (search-narrowed to its own marker rows) match an SQL recompute scoped to those same ids. Validated green against staging 3 times (twice by the audit's admin role-agent, once independently re-run by the main loop) before shipping; guarded by `E2E_DB_READY` |
| Completed Jobs — ledger renders, search by ref, empty-state | ✅ | office/jobs.spec.ts |
| Clients — toggle/search, detail, add-client dialog | ✅ | office/clients.spec.ts |
| Documents — tabs + search | ✅ | office/records.spec.ts |
| Claims — register + working page (advance → settle w/ resolution + amount) | ✅ | office/records.spec.ts + claims.spec.ts |
| Content — review-state tabs | ✅ | office/records.spec.ts |
| Staff & Fleet — tabs + add dialogs | ✅ | office/staff-fleet.spec.ts |
| Storage — create site → add unit → assign client at a rate (occupied) | ✅ | office/storage.spec.ts |
| Performance — Overview/Sales/Storage tabs | ✅ | office/reports.spec.ts |
| Growth — Website & Tracking, Ads | ✅ | office/reports.spec.ts |
| Automations (AI survey log) | ✅ | office/reports.spec.ts |
| Settings — admin sees every control | ✅ | office/settings.spec.ts |
| P0 #1 deposit+balance separated (money) | ✅ | office/p0-money.spec.ts |

## Estimator features
| Flow | Status | Spec |
|---|---|---|
| Cockpit "My day" → start a quote | ✅ | estimator/journey.spec.ts |
| Access — every nav route loads; /finance* redirect | ✅ | estimator/access + gating.spec.ts |
| Settings trimmed (no admin money/team controls) | ✅ | estimator/settings.spec.ts |
| Leads scoped to own / Mine preset | ✅ | estimator/work.spec.ts |
| Build + send a quote | ⬜ | estimator/quote.spec.ts |
| Book survey (past slot, attended) → Create Quote from the visit (Quotes-tab `<Link>` entry) | 🟡 | estimator/work-quote.spec.ts — proven live 2026-08-22 via a throwaway login + SQL read-back (0 findings), but the spec itself is `test.skip`'d: this env has no `E2E_ESTIMATOR_PASSWORD` so `auth.setup.ts` can't sign in the persistent estimator fixture, so it has never actually executed |
| Book survey → Create Quote from the survey visit's view dialog (`router.push` entry, QA-20260827-03) | 🟡 | estimator/work-quote.spec.ts (2nd describe block) — ran green live against staging 2026-08-28 via a throwaway minted login (3/3 passed, SQL read-back confirmed exactly 1 `quotes` row, no error boundary); same `E2E_ESTIMATOR_PASSWORD` gap as the row above keeps it `test.skip`'d in CI |
| My invoices — invoicing unlocked (gates pass) | ✅ | estimator/pay.spec.ts |
| My invoices — create/add a line by hand/edit/submit | ✅ | estimator/pay-statement.spec.ts |

## Crew features
| Flow | Status | Spec |
|---|---|---|
| Access — /my-jobs routes load; bounced off dashboard | ✅ | crew/access.spec.ts |
| Jobs list + week strip + job sheet PDF | ✅ | crew/journey.spec.ts |
| P0 #7 offline completion, #8 double-submit sign-off | ✅ | crew/p0.spec.ts |
| Job detail — brief + add a private crew note | ✅ | crew/job-detail.spec.ts |
| Job detail — add a note WITH a photo (upload → bucket object → fresh-context image load) | ✅ | crew/job-detail.spec.ts |
| Job detail agrees with the job list on completion (QA-20260902-03) | 🟡 | crew/job-completion-status-consistency.spec.ts — added 2026-09-02 QA audit (crew role-agent live-verified the mismatch against a real auto-completed staging appointment: list's "Done" pill is keyed on `appointments.status`, but the detail page's banner/Complete-job-button gate is keyed on a `job_completions` row existing, so an appointment the balance-settled cron auto-completes — no crew signature, no `job_completions` row — still offers "Complete job" on its own detail page). Seeds its own marker appointment against the persistent e2e-crew login; tsc/eslint clean, `playwright test --list` loads it under crew (1 test). un-skipped by the qa-repair PR (detail page now keys completion on `appointments.status` via `jobDetailCompletion`); per AGENTS.md, treat as unverified until it has gone green in CI twice |
| Availability — normal week + calendar render | ✅ | crew/availability.spec.ts |
| Hours log — add, edit, clear a day | 🟡 | crew/hours.spec.ts — proven live 2026-08-24 via a throwaway crew login + SQL read-back (0 findings), but `test.skip`'d: this env has no `E2E_CREW_PASSWORD` so `auth.setup.ts` can't sign in the persistent crew fixture, so it has never actually executed |
| Hours log — expense amount/note + receipt photo upload | 🟡 | crew/expense-receipt.spec.ts — never had a spec before (0 grep matches for "receipt\|expense" anywhere under e2e/, flagged 2026-08-23 and 2026-08-24); proven live 2026-08-24 via a throwaway crew login + storage/DB read-back (real JPEG bytes round-tripped through the bucket, `receipt_key` matching the object, 0 findings). `test.skip`'d: this env has no `E2E_CREW_PASSWORD`, so it has never actually executed |
| Push opt-in is NOT offered to crew (QA-20260823-04) | ✅ | crew/push-optin.spec.ts |
| Contractor agreement gate → sign → invoicing unlocks | ✅ | crew/contractor.spec.ts |
| Contractor invoicing — start/add a line by hand/edit/submit | ✅ | crew/invoicing-submit-lines.spec.ts |
| Handoff h2: crew submits an invoice → office sees it on /finance/statements | 🟡 | crew/hours-to-admin-statements.spec.ts — proven live 2026-08-22 via a throwaway crew+office login pair + SQL read-back (0 findings), but `test.skip`'d: this env has no `E2E_CREW_PASSWORD`/`E2E_OFFICE_PASSWORD` so `auth.setup.ts` can't sign in either persistent fixture, so it has never actually executed |
| Handoff h8: admin changes a booking date on /bookings → crew's /my-jobs reflects it | ✅ | office/removal-changedate-to-crew.spec.ts — found a real bug (QA-20260823-01): inside the 7-day window "Change date" is a cancel+rebook, `appointment_assignments` never carries to the new appointment row, and the dropped crew member's /my-jobs silently showed nothing assigned with no cancellation notice. Fixed in #54 (a "Called off" card) and the spec **un-skipped**; its first CI run then failed on its own seed (#61 — `deposit_amount` set without `deposit_paid_at`, so the booking bucketed `deposit_outstanding` and never showed a Change date button). Both tests green in CI since |
| Handoff h9: admin assigns crew via Day Allocation → crew's /my-jobs reflects it (UK-local date/time) | 🟡 | office/crew-assignment-to-myjobs.spec.ts — the healthy counterpart to h8 (plain `appointment_assignments` insert, unrelated to the change-date bug); proven live 2026-08-23 via a throwaway admin+crew login pair + SQL read-back, 0 findings. `test.skip`'d: this env has no `E2E_OFFICE_PASSWORD`/`E2E_CREW_PASSWORD` so `auth.setup.ts` can't sign in either persistent fixture — expected to pass once set, not blocked by any bug |
| Handoff h5: /join submission → admin approves in Staff & Fleet (staff row created, no login) | 🟡 | office/join-approve-handoff.spec.ts — proven live 2026-08-26 via two concurrent QA-SENTINEL role-agents (public /join submit + throwaway admin login) + SQL read-back, 0 findings; matches the deliberate approve/activate/invite design already noted on `staff_vehicle_crud_join_approve` in qa/state.json. `test.skip`'d: this env has no `E2E_OFFICE_PASSWORD` so `auth.setup.ts` can't sign in the office fixture — expected to pass once set, not blocked by any bug |

## Public (no auth)
| Flow | Status | Spec |
|---|---|---|
| /q accept → deposit invoice (staging), and NO balance on an ordinary booking | ✅ | public/customer.spec.ts |
| /q accept a move inside T-7 → collapsed 25% ask AND balance both raised, summing to the agreed price (staging) | ✅ | public/customer.spec.ts |
| /q commitment step offers 25% (default) or settle in full, bank Amount follows the choice | ✅ | public/settle-in-full.spec.ts |
| /q settle in full → the T-7 balance is raised early, once, for the remainder (staging) | ✅ | public/settle-in-full.spec.ts |
| /q decline with reason | ✅ | public/decline.spec.ts |
| /q a sent commercial quote renders review-only, no accept button/deposit copy (PRD §3.10) | ✅ | public/commercial-accept.spec.ts — QA-20260828-03 closed, spec un-skipped in its repair PR. Re-confirmed live 2026-09-01 QA audit (customer role-agent, post the gate 16/20 accept-flow rewrite): 0 residential copy leaked, 0 card UI/script references, commercial "Nothing to pay now… payable on your agreed terms" copy exact |
| /s storage-agreement signing (render + affordance + bad-token 404) | ✅ | public/signing.spec.ts |
| /s payment-method copy matches the current storage-terms version | 🟡 | public/signing.spec.ts — shipped `test.skip`, QA-20260901-01: `app/s/[token]/page.tsx:170` hardcodes "Invoices are payable by bank transfer on receipt.", now stale against storage-terms-v2-2026-08-31 (card/cash also accepted); un-skips once the page sources the payment-method line from the current terms version |
| /cv customer cubic survey self-fill (render + search + bad-token 404) | ✅ | public/cubic.spec.ts |
| /sheet crew day sheet, no login (render + price-free + bad-token 404) | ✅ | public/day-sheet.spec.ts |
| /join crew sign-up (submit → success state + bad-token dead-link card) | ✅ | public/join.spec.ts |
| **Brand-leak scan — the RENDERED half (PRD §6.4 / §10).** Seeds a second-brand quote, storage let and cubic survey, opens `/q`, `/s`, `/cv` and scans the post-hydration DOM (visible text + markup, `<script>`/`<style>` stripped — the RSC flight payload splits literals at arbitrary byte boundaries and would produce both false negatives and false positives) for every `brand: 'marley'` literal, then the reverse over the default-brand records for every `brand: 'pitmans'` literal. Closes the half `scripts/brand-leak-scan.mjs` says in its own header it cannot do: a literal arriving through a brands-table value, a helper outside the manifest, or a re-pointed `mm-red` token is invisible to a source grep by construction | 🟡 | public/brand-leak-rendered.spec.ts — 🟡 until its first green CI run, per the standing rule that an audit-written spec is done when CI proves it (four in a row broke on first run in Aug 2026). Written 2026-09-02 and **still has never executed** — this env has no `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, so `E2E_DB_READY` is false. Verified here only that it loads (`playwright test --list` → 4 tests under `public`) and lints. Everything it asserts was derived by reading `app/{q,s,cv,sheet,join}/[token]/page.tsx`, `lib/brand-page-theme.ts`, `lib/brand.ts` and `0104_brands.sql`, not observed. Repaired the same day, before any run: the did-it-render precondition summed text **and markup** length (thousands of chars on any response, so it could not fire), and the fixtures used hardcoded values on four UNIQUE columns with a teardown that bailed on a partial seed — now per-run ids, `E2E `-prefixed so `scripts/seed-e2e.mjs`'s existing sweep reclaims anything a killed process leaves, and the ids accumulate as they land so a partial seed is still torn down and still read back |
| Brand-leak (rendered), the colour half: a second-brand page's computed `--color-mm-red` is **the one colour the data rule says it must be** — not merely one of the brand's two colours. `brandCtaColour` rejects `colour_accent` when white text on it is illegible (Pitmans' yellow), so the expectation is re-derived from the brands row inside the spec rather than imported: deleting that legibility rule turns this red instead of moving with it. A **default-brand** page emits no inline override at all (the §1 byte-parity invariant, observed rather than argued) | 🟡 | public/brand-leak-rendered.spec.ts — same first-run caveat |
| Group surfaces `/sheet` + `/join` are coloured as **neither** brand (`GROUP_PAGE_THEME`'s neutral charcoal), asserted **on the real rendered surface**: each has an expected-state regex (the day sheet's "This link opens without signing in", the sign-up form's "Fill in your details below") plus named refusals for the three error cards these routes serve at HTTP 200 through the same charcoal shell — an expired day sheet (`work_date` older than `STALE_DAYS=3`, so a stale seed fails LOUDLY naming the staleness), a twice-failed day assembly, and `/join`'s dead-link card. Without those, status + colour alone could not tell a rendered sheet from a dead link, and the pass greened over two error screens. No literal assertion runs on them, deliberately: the group's identity IS the operating company, and PRD §4 puts a per-job brand chip on a mixed-brand day sheet, so literals in either direction are the page's own content | 🟡 | public/brand-leak-rendered.spec.ts — same first-run caveat |

## Single-brand parity (multi-brand PRD §6.1 / §11.10 — `parity` project, runs LAST)
| Flow | Status | Spec |
|---|---|---|
| With only Marley active, no brand UI renders on the 19 routes `/`, `/leads`, `/quotes`, `/bookings`, `/leads/new`, `/settings`, `/clients`, `/follow-ups`, `/documents`, `/claims`, `/content`, `/payments`, `/refunds`, `/schedule`, `/schedule/removals`, `/schedule/surveys`, `/resources`, `/storage`, `/performance` (schedule/removals/surveys added at gate 11 — diary brand colours/filter/legend and the appointment dialog's `brand-picker` are all multi-brand-gated; the hollow-unconfirmed dashed removal rendering deliberately ISN'T, renders here, and carries no brand testid or text; /resources + /storage added at gate 12 — vehicle livery chip/select, the job-board livery-mismatch note, storage site/let chips, brand filter and dialog brand selects are all multi-brand-gated; note /resources' real PageHeader title is "Staff & Fleet"; /performance added at gate 21 — the TabBar brand filter, visits-list chips and Jobs & margin Brand column are all multi-brand-gated, and the already-listed `/` now has teeth on the dashboard's gate-21 KPI sub-lines and section filter row) — zero `brand-chip` testids, zero `brand-filter` testids, zero `brand-settings-card` testids (gate 2's Settings › Brands card must hide in single-brand mode), no "Pitmans" text. Deactivates Pitmans via service role in beforeAll (staging seeds it active); afterAll reactivates AND reads the row back, throwing on failure. The project sits last in playwright.config.ts on purpose: it mutates global brand state and must never run alongside brand specs | 🟡 | parity/single-brand.spec.ts — written at gate 1 (asserting the pre-brand-UI baseline; the testids are the contract later gates must use). 🟡 until its first green CI run: three consecutive audit-written specs broke on first CI run in Aug 2026, so a spec is "done" when CI proves it, not when it's written |

## Bugs this suite surfaced
- **`/sheet/<token>` was 307'd to /login** — the crew day-sheet page (designed to
  open from an SMS with no login, same token-as-credential model as /q /s /cv) was
  missing from the auth-proxy public allowlist in `lib/supabase/proxy-session.ts`.
  The feature was broken for its entire intended use. Fixed (one allowlist line);
  `public/day-sheet.spec.ts` is the regression guard.

## Notes
- Money-path invariants that AREN'T automated E2E (manual-in-Zoho refunds/credit
  notes, VAT-quarter maths, takepayments declined-card) are `fixme` with reasons
  in office/p0-money.spec.ts — unit-covered where applicable.
- Seed states live in scripts/seed-e2e.mjs + fixtures/seed-data.ts; extend there
  as feature specs need new fixtures (a lead per stage, a submitted statement, a
  storage let, etc.).
- **Second-brand fixtures are seeded by the spec, not by the shared seed.**
  `public/brand-leak-rendered.spec.ts` and `office/quote-brand-ref.spec.ts` both
  create and tear down their own Pitmans rows. Deliberate: a permanent
  second-brand record in `scripts/seed-e2e.mjs` would show up in every list,
  count and bucket the other specs assert against, and would still be sitting
  there when the `parity` project deactivates Pitmans at the end of the run.
  Both teardowns are FK-ordered and THROW — a swallowed `23503` leaking a marker
  set into staging while the report said "clean" is the `#71` lesson. A
  spec-owned fixture is named `E2E …` so `scripts/seed-e2e.mjs`'s `ilike('E2E %')`
  sweep can reclaim it, AND carries a per-run suffix on every UNIQUE column
  (`quotes.quote_ref`, `quotes.accept_token`, `storage_lets.sign_token`,
  `cubic_surveys.share_token`) so one leaked row cannot duplicate-key every
  later run. Record the ids as each insert lands rather than returning them at
  the end: a fixture assigned only after the last insert leaves a partial seed
  untorn-down and skips the read-back that is the evidence of a clean exit.
- **A teardown must not delete a PARENT whose child delete failed.** Recording
  every error and carrying on is not enough, because two of these FKs are
  `on delete set null` rather than restrict: `cubic_surveys.lead_id` (0029) and
  `signatures.storage_let_id` (0027). Deleting the parent after a failed child
  delete therefore SUCCEEDS and nulls the only column that could find the child
  again — the survey falls outside `scripts/seed-e2e.mjs`'s sweep (which reaches
  surveys through their `E2E ` leads), and an orphaned signature is beyond every
  sweep there is, `signatures` having no `notes` column and no name. The report
  read as "one delete failed, the rest cleaned"; it had in fact made one row
  permanently unreclaimable. `public/brand-leak-rendered.spec.ts` now runs each
  chain in FK LEVELS and stops at the first level that failed, leaving the
  parents attached and saying so by name in the thrown message. Same shape as
  the `#71` lesson one step further out: proving a delete happened is not the
  same as not making things worse when it did not.
- **The brand-leak literal list has one home.** `scripts/brand-leak-literals.mjs`
  holds `FORBIDDEN` and the detector; `scripts/brand-leak-scan.mjs` (the source
  grep and its vitest twin) and `public/brand-leak-rendered.spec.ts` both import
  it. The split exists because Playwright transpiles specs to CommonJS and the
  scan script's `import.meta.url` cannot survive that — a spec importing the scan
  directly fails at load. Do not restate the list in either half.
