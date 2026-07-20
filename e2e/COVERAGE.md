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
| Estimator — /finance, /finance/statements, / redirect | ✅ | estimator/gating.spec.ts |

## Office / admin features
| Flow | Status | Spec |
|---|---|---|
| Dashboard — period tabs, needs-action cards | ✅ | office/dashboard.spec.ts |
| Leads — presets, search, add-lead create → detail | ✅ | office/leads.spec.ts |
| Lead detail — stepper, action bar per stage, tabs | ⬜ | office/lead-detail.spec.ts |
| Follow-ups — snooze/done/no-reply | ⬜ | office/follow-ups.spec.ts |
| Pipeline Board — week nav, move + reason, mark-lost | ⬜ | office/pipeline-board.spec.ts |
| Quotes — list presets, search, open | ✅ | office/quotes.spec.ts |
| Quote builder wizard — new quote → send → PDF | ⬜ | office/quote-builder.spec.ts |
| Bookings — sections, mark-paid dialog (balance = P0#1) | ✅ | office/bookings.spec.ts + p0-money |
| Payments — day view, stat sections | ✅ | office/payments-finance.spec.ts |
| Finance — Invoices & VAT / FRS (reads staging Zoho) | ✅ | office/payments-finance.spec.ts |
| Contractor pay — return/mark-paid/void | ⬜ | office/contractor-pay.spec.ts |
| Schedule — survey + removal diary, new-appt dialog | ✅ | office/schedule.spec.ts |
| Job Board — capacity, assign (modal + drag), off-road | ⬜ | office/job-board.spec.ts |
| Completed Jobs | ⬜ | office/jobs.spec.ts |
| Clients — toggle/search, detail, add-client dialog | ✅ | office/clients.spec.ts |
| Documents — tabs + search | ✅ | office/records.spec.ts |
| Claims — register tabs (working page ⬜) | 🟡 | office/records.spec.ts |
| Content — review-state tabs | ✅ | office/records.spec.ts |
| Staff & Fleet — tabs + add dialogs | ✅ | office/staff-fleet.spec.ts |
| Storage — page + add-site dialog (full let flow ⬜) | 🟡 | office/storage.spec.ts |
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
| My invoices — contractor-agreement gate → invoice | ⬜ | estimator/pay.spec.ts |

## Crew features
| Flow | Status | Spec |
|---|---|---|
| Access — /my-jobs routes load; bounced off dashboard | ✅ | crew/access.spec.ts |
| Jobs list + week strip + job sheet PDF | ✅ | crew/journey.spec.ts |
| P0 #7 offline completion, #8 double-submit sign-off | ✅ | crew/p0.spec.ts |
| Job detail — brief + add a private crew note | ✅ | crew/job-detail.spec.ts |
| Availability — normal week + calendar render | ✅ | crew/availability.spec.ts |
| Contractor agreement gate → sign (needs self-billing seed) | ⬜ | crew/contractor.spec.ts |
| Contractor invoicing — start/add lines/submit | ⬜ | crew/contractor.spec.ts |

## Public (no auth)
| Flow | Status | Spec |
|---|---|---|
| /q accept → deposit invoice (staging) | ✅ | public/customer.spec.ts |
| /q decline with reason | ✅ | public/decline.spec.ts |
| /s storage-agreement signing (needs let-token seed) | ⬜ | public/signing.spec.ts |
| /cv customer cubic survey self-fill (needs token seed) | ⬜ | public/cubic.spec.ts |
| /sheet crew day sheet (needs sheet-token seed) | ⬜ | public/day-sheet.spec.ts |

## Notes
- Money-path invariants that AREN'T automated E2E (manual-in-Zoho refunds/credit
  notes, VAT-quarter maths, takepayments declined-card) are `fixme` with reasons
  in office/p0-money.spec.ts — unit-covered where applicable.
- Seed states live in scripts/seed-e2e.mjs + fixtures/seed-data.ts; extend there
  as feature specs need new fixtures (a lead per stage, a submitted statement, a
  storage let, etc.).
