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
| Dashboard — period tabs, needs-action cards | ⬜ | office/dashboard.spec.ts |
| Leads — filters/presets, search, sort, quick actions | ⬜ | office/leads.spec.ts |
| Add lead → lead detail | ⬜ | office/leads.spec.ts |
| Lead detail — pipeline stepper, action bar per stage, tabs | ⬜ | office/lead-detail.spec.ts |
| Follow-ups — snooze/done/no-reply | ⬜ | office/follow-ups.spec.ts |
| Pipeline Board — week nav, drag, backward-move reason, mark-lost | ⬜ | office/pipeline-board.spec.ts |
| Quotes — list presets, search, accept/reject/resend | ⬜ | office/quotes.spec.ts |
| Quote builder wizard — new quote → send → PDF | ⬜ | office/quote-builder.spec.ts |
| Bookings — deposit paid (BACS/cash), book removal, balance | ✅ (balance = P0#1) | office/bookings.spec.ts |
| Payments — day view, card/recorded sections | ⬜ | office/payments.spec.ts |
| Finance — Invoices & VAT, VAT/FRS, quarter | 🟡 (reads staging Zoho) | office/finance.spec.ts |
| Contractor pay — return/mark-paid/void | ⬜ | office/contractor-pay.spec.ts |
| Schedule — survey diary, removal diary, new appointment | ⬜ | office/schedule.spec.ts |
| Job Board — capacity, assign (modal + drag), off-road, job sheet | ⬜ | office/job-board.spec.ts |
| Completed Jobs | ⬜ | office/jobs.spec.ts |
| Clients — grid/list/sort/search, client detail, new quote for client | ⬜ | office/clients.spec.ts |
| Documents — contracts/certs/unsigned/contractor agreements tabs | ⬜ | office/documents.spec.ts |
| Claims — register + working page (status/resolution) | ⬜ | office/claims.spec.ts |
| Content — job content review queue | ⬜ | office/content.spec.ts |
| Staff & Fleet — staff, vehicles, compliance, availability wall chart | ⬜ | office/staff-fleet.spec.ts |
| Storage — sites/units/lets, agreement, billing | ⬜ | office/storage.spec.ts |
| Performance — Overview/Sales/Storage tabs | ⬜ | office/performance.spec.ts |
| Growth — Website & Tracking, Ads | ⬜ | office/growth.spec.ts |
| Automations (AI survey) | ⬜ | office/automations.spec.ts |
| Settings — every control + admin-only gating | ⬜ | office/settings.spec.ts |
| P0 #1 deposit+balance separated (money) | ✅ | office/p0-money.spec.ts |

## Estimator features
| Flow | Status | Spec |
|---|---|---|
| Cockpit "My day" → start a quote | ✅ | estimator/journey.spec.ts |
| Leads scoped to own / Mine preset | ⬜ | estimator/work.spec.ts |
| Build + send a quote | ⬜ | estimator/quote.spec.ts |
| My invoices — contractor-agreement gate → invoice | ⬜ | estimator/pay.spec.ts |
| Settings trimmed (Quick sign-in + Notifications) | ⬜ | estimator/settings.spec.ts |

## Crew features
| Flow | Status | Spec |
|---|---|---|
| Jobs list + week strip + job sheet PDF | ✅ | crew/journey.spec.ts |
| P0 #7 offline completion, #8 double-submit | ✅ | crew/p0.spec.ts |
| Job detail — sign-off, crew notes+photos, content capture | 🟡 (#7/#8 sign off) | crew/job-detail.spec.ts |
| Availability — normal week + calendar override | ⬜ | crew/availability.spec.ts |
| Contractor agreement gate → sign | ⬜ | crew/agreement.spec.ts |
| Contractor invoicing — start/add lines/submit | ⬜ | crew/pay.spec.ts |

## Public (no auth)
| Flow | Status | Spec |
|---|---|---|
| /q accept → deposit invoice (staging) | ✅ | public/customer.spec.ts |
| /q decline with reason | ⬜ | public/customer.spec.ts |
| /s storage-agreement signing | ⬜ | public/signing.spec.ts |
| /cv customer cubic survey self-fill | ⬜ | public/cubic.spec.ts |
| /sheet crew day sheet (read-only) | ⬜ | public/day-sheet.spec.ts |

## Notes
- Money-path invariants that AREN'T automated E2E (manual-in-Zoho refunds/credit
  notes, VAT-quarter maths, takepayments declined-card) are `fixme` with reasons
  in office/p0-money.spec.ts — unit-covered where applicable.
- Seed states live in scripts/seed-e2e.mjs + fixtures/seed-data.ts; extend there
  as feature specs need new fixtures (a lead per stage, a submitted statement, a
  storage let, etc.).
