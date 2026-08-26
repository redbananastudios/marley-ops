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
| Finance — Invoices & VAT / FRS (reads staging Zoho) | ✅ | office/payments-finance.spec.ts |
| Bank feed — whole-quote link (deposit+balance settled in one transfer) | ✅ | office/bank-feed-whole-quote.spec.ts |
| Contractor pay — return a submitted invoice | ✅ | office/contractor-pay.spec.ts |
| Schedule — survey + removal diary, new-appt dialog | ✅ | office/schedule.spec.ts |
| Schedule — existing-appointment VIEW dialog (crew/vans, job notes two-hats, price-free) | ✅ | office/appointment-view-dialog.spec.ts |
| Schedule — gate-11 diary brand layer (brand-derived fills, hollow-unconfirmed → solid flip on `date_confirmed_at`, survey-always-solid accent fill, brand initials, legend) | ✅ | office/diary-brand-layer.spec.ts — every assertion validated live against deployed staging by the 2026-08-26 overnight audit (a byte-identical scratch runner of the spec's seed/locators/assertions/teardown: 20/20 ok incl. teardown-to-zero) before shipping; guarded by `E2E_DB_READY`, runtime-skips if <2 active brands |
| Job Board (now embedded in /schedule as JobBoardView) — resources, week nav, assign modal | ⬜ | none — office/job-board.spec.ts was deleted by PR #60 (Job Board page removal, component kept) and never replaced; office/schedule.spec.ts only covers the survey/removal diary, not the allocation board embedded alongside it. Found stale (still listed ✅) by the 2026-08-24 QA audit — corrected here, not re-written this run |
| Board (/board) — pipeline kanban by stage | ⬜ | none — proven live 2026-08-24 by the QA audit (admin.board_kanban_jobs_list in qa/state.json) via a throwaway login + independent SQL recompute of all 6 columns (0 findings), but has never had a permanent spec |
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
| Leads scoped to own / Mine preset | ⬜ | estimator/work.spec.ts |
| Build + send a quote | ⬜ | estimator/quote.spec.ts |
| Book survey (past slot, attended) → Create Quote from the visit | 🟡 | estimator/work-quote.spec.ts — proven live 2026-08-22 via a throwaway login + SQL read-back (0 findings), but the spec itself is `test.skip`'d: this env has no `E2E_ESTIMATOR_PASSWORD` so `auth.setup.ts` can't sign in the persistent estimator fixture, so it has never actually executed |
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
| /q accept → deposit invoice (staging) | ✅ | public/customer.spec.ts |
| /q decline with reason | ✅ | public/decline.spec.ts |
| /s storage-agreement signing (render + affordance + bad-token 404) | ✅ | public/signing.spec.ts |
| /cv customer cubic survey self-fill (render + search + bad-token 404) | ✅ | public/cubic.spec.ts |
| /sheet crew day sheet, no login (render + price-free + bad-token 404) | ✅ | public/day-sheet.spec.ts |
| /join crew sign-up (submit → success state + bad-token dead-link card) | ✅ | public/join.spec.ts |

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
