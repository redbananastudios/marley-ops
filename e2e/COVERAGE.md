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
| Bookings — sections, mark-paid dialog (balance = P0#1) | ✅ | office/bookings.spec.ts + p0-money |
| Payments — day view, stat sections | ✅ | office/payments-finance.spec.ts |
| Finance — Invoices & VAT / FRS (reads staging Zoho) | ✅ | office/payments-finance.spec.ts |
| Contractor pay — return a submitted invoice | ✅ | office/contractor-pay.spec.ts |
| Schedule — survey + removal diary, new-appt dialog | ✅ | office/schedule.spec.ts |
| Job Board — resources, week nav, assign modal | ✅ | office/job-board.spec.ts |
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
| My invoices — invoicing unlocked (gates pass) | ✅ | estimator/pay.spec.ts |
| My invoices — create/add a line by hand/edit/submit | ✅ | estimator/pay-statement.spec.ts |

## Crew features
| Flow | Status | Spec |
|---|---|---|
| Access — /my-jobs routes load; bounced off dashboard | ✅ | crew/access.spec.ts |
| Jobs list + week strip + job sheet PDF | ✅ | crew/journey.spec.ts |
| P0 #7 offline completion, #8 double-submit sign-off | ✅ | crew/p0.spec.ts |
| Job detail — brief + add a private crew note | ✅ | crew/job-detail.spec.ts |
| Availability — normal week + calendar render | ✅ | crew/availability.spec.ts |
| Contractor agreement gate → sign → invoicing unlocks | ✅ | crew/contractor.spec.ts |
| Contractor invoicing — start/add a line by hand/edit/submit | ✅ | crew/invoicing-submit-lines.spec.ts |

## Public (no auth)
| Flow | Status | Spec |
|---|---|---|
| /q accept → deposit invoice (staging) | ✅ | public/customer.spec.ts |
| /q decline with reason | ✅ | public/decline.spec.ts |
| /s storage-agreement signing (render + affordance + bad-token 404) | ✅ | public/signing.spec.ts |
| /cv customer cubic survey self-fill (render + search + bad-token 404) | ✅ | public/cubic.spec.ts |
| /sheet crew day sheet, no login (render + price-free + bad-token 404) | ✅ | public/day-sheet.spec.ts |
| /join crew sign-up (submit → success state + bad-token dead-link card) | ✅ | public/join.spec.ts |

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
