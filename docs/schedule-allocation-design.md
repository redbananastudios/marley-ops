# Schedule & Allocation — design

**Status:** Design for review (not yet implemented). Peter, 2026-07-29.
**Preview:** interactive mockup — https://claude.ai/code/artifact/f64813ec-8209-49eb-80a7-e0946abe2bfa
**Rule:** this reshapes the diary + Job Board *around* Payments Policy v2, refund queue, clash/availability and the quote-derived requirements — it **builds on those, never refactors them**.

## Objective

Make the Removals diary and the Job Board feel like **two views of one workflow**, and fix the operational issues that are cheap to fix now (empty DB) and expensive later:

1. Date certainty is currently welded to sales status (one linear `lead.status`). Separate it.
2. There is no concept of *soft demand* (£100 down, no firm date) — the "who's thinking about August" list.
3. The month has no at-a-glance "can we take another move on this day?" signal.
4. Confirmed jobs get crewed nearer the date (dispatch), so "confirmed but unallocated" must be a first-class, normal state.

**Not** a rebuild. One new page, `/schedule`, with two tabs sharing a selected date.

## Decisions locked this session (Peter)

| # | Decision |
|---|---|
| D1 | **One page, two tabs:** *Availability* (sell) + *Day Allocation* (dispatch). Shared selected date via `?date=`. |
| D2 | **Surveys come off the Job Board** — it becomes moves-only allocation. Surveys stay on the diary/Availability side. |
| D3 | **The diary/month is factual only** — a booking shows on the grid **only when Confirmed (25% paid)**. Everything softer is off-grid. |
| D4 | **Soft demand = a list panel** beside the month ("Thinking about it"), grouped by window. £100 = on the list, not a date. |
| D5 | **Two capacity denominators.** Availability grades on **required** vans/crew of confirmed jobs vs fleet ("can we sell it?"). Day Allocation works on **assigned** vs required ("is it ready to run?"). |
| D6 | **Capacity states** derived live (worst of vans/crew): **Available** = spare van *and* crew · **Limited** = down to the last of either · **Full** = no spare van *or* crew · **Over** = required exceeds fleet. Thresholds are config; fleet counts read live from Staff & Fleet. |
| D7 | **Date certainty is first-class**, separate from `lead.status`: *approximate window* / *provisional date* / *confirmed date*. Only Confirmed hits the diary + hard capacity. |
| D8 | **Booking is its own entity** (not a `lead.status` value). One booking per client now; model allows **multiple moves per client** later (commercial / housing associations). |
| D9 | **Homeowner vs rented = a date-flex flag** (homeowner = fixed to their sale; rented = movable), used to decide what can shift when a day is over. |
| D10 | **Packing day is first-class** — an optional pack day (own date, usually the day before) with a **crew-only** requirement, shown as its own dispatch card; consumes crew, no van. |
| D11 | **Confirmed-but-unallocated is normal** — crew allocated nearer the date. Shows "awaiting crew" in dispatch; still commits capacity for sellability. |
| D12 | **Driver-aware crew:** `is_driver` yes/no per person (no licence classes yet). A fully-allocated booking needs a van **and** a driver among the assigned crew — **warn only, never block** (like clash warnings). |
| D13 | **The month stays purely sellability** — no "crew to do" marker on the grid; allocation status lives in the dispatch tab. |
| D14 | **Icons:** flat line icons (lucide, the app's existing family). Driver cue is in-theme (charcoal/mist + wheel mark), not a new hue. |

## Current implementation (what we build on)

- **Diary:** `components/schedule/scheduler-view.tsx` (FullCalendar; removals default to month, "Show surveys" overlay). Reschedule of a booked removal already routes through the Payments Policy v2 `ChangeDateDialog` (7-day refund window).
- **Job Board:** `components/job-board/job-board-view.tsx` — week grid, resource rail (drag + Assign modal), per-day capacity strip, clash warnings, quote-derived `required {vans, men}`, "signature needed on arrival". Helpers in `lib/job-board.ts` (`resourceDayState`, `clashesFor`, `apptDays`), `lib/staff/availability.ts`, `lib/fleet/availability.ts`.
- **Status model:** one linear `lead.status` (`website_enquiry → survey_booked → quoted → provisional → confirmed → completed`, +`declined`) in `components/lead-status-badge.tsx` / `lib/dashboard/compute.ts`. **This is the conflation D7/D8 unpick.**
- **Money/date layer (reuse wholesale):** Payments Policy v2 (migrations `0073`/`0074`, `lib/payments-policy.ts`, `lib/quote/payments.ts`) — £100 deposit, 25% commitment due 7 days out, date-confirm, commitment-chase, dates-at-risk, refund queue, single date-change path.
- **Bookings page:** `app/(dashboard)/bookings/page.tsx` already exists — becomes the money/action queue (§ below), not another diary.

---

## 1. Recommended UX changes

**One page `/schedule`, two tabs, one selected date (`?date=`).**

### Tab A — Availability ("can we sell this day?")
- The existing month calendar is the base. Each **day cell** gains a derived capacity state (D6): Available / Limited / Full / Over, coloured by the existing success/warn/danger tokens, with a small "🚚 n · 👥 n free" footer. Only **Confirmed** bookings render as chips (D3).
- **Click a day** → a right-hand summary: vans/crew free, what's booked, **provisional interest around that date** with a "Reserve / call" action (the "ring them to lock it in" move), and a ±3-day strip so you can offer an alternative.
- **Soft-demand panel** ("Thinking about it", D4): £100-down customers grouped by window (August / September), each showing their vans/crew estimate (known — the survey's done) and £100 status. Off the grid entirely.
- No allocation status on this tab (D13).

### Tab B — Day Allocation ("is this day ready to run?") — the dispatch view
- Single day (the shared date). This is the current Job Board, single-day, **moves only** (D2), with:
  - **Driver-aware crew** (D12): rail + assigned chips show who can drive (in-theme charcoal + wheel mark). A job with a van but no driver among assigned crew shows a **warn-only** "no driver" flag.
  - **Awaiting-crew** state (D11): a Confirmed, paid job with no crew yet reads "crew allocated nearer the date", not an error.
  - **Packing-day card** (D10): crew-only, day-before, its own card.
  - Existing clash warnings, staff/vehicle availability, compliance badges, "signature needed", quote-derived required-vs-assigned — all retained.

### One shared booking drawer (D8)
- A single create/edit drawer opened from the **lead record, the Bookings page, the Availability calendar, and Day Allocation** — no separate "provisional" vs "confirmed" forms. Fields: customer, approximate window, provisional date, confirmed date + start/finish, homeowner/rented, vans required, crew required, £100 status, 25% status, notes.

### Bookings page → money/action queue (not a diary)
Re-group the existing page into action buckets: **£100 outstanding · Booked, no date · Provisional · 25% due soon · 25% overdue · Confirmed, not allocated · Balance outstanding.** Each row deep-links to the shared drawer / the day.

## 2. Components that can be reused (as-is or nearly)

| Component | Reuse |
|---|---|
| `SchedulerView` / FullCalendar | Base of the Availability month; keep event render, reschedule flows. |
| `JobBoardView` `JobCard` / `AssignDialog` / `CapacityStrip` | Base of Day Allocation (single-day). Keep drag rail, Assign modal, clash UI. |
| `lib/job-board.ts` (`resourceDayState`, `clashesFor`, `apptDays`) | Feeds **both** capacity denominators (D5). |
| `lib/staff/availability.ts`, `lib/fleet/availability.ts`, `vehicleNeedsAttention` | Crew/van availability + compliance, unchanged. |
| Payments Policy v2 (`lib/payments-policy.ts`, `lib/quote/payments.ts`, `ChangeDateDialog`, commitment-chase, refund queue) | Deposit/25%/date-change/refund — **reused wholesale, not touched**. |
| Quote-derived `required {vans, men}` | The demand numbers behind capacity grading. |
| Marley design tokens / responsive shell | The whole UI stays on-theme (D14). |

## 3. Components to merge or amend

- **Merge:** the `/schedule/removals` diary and the Job Board into `/schedule` with `Availability` + `Day Allocation` tabs sharing `?date=`.
- **Amend `SchedulerView`:** add per-day capacity grading (required vs live fleet); remove the survey overlay from the board path; render only Confirmed as slots; add the soft-demand panel + day summary.
- **Amend `JobBoardView`:** single-day mode; driver-aware chips; awaiting-crew state; packing cards; drop the survey toggle.
- **Amend the status model:** stop reading `lead.status` for date certainty; introduce the booking entity (§4). `lead.status` keeps its **sales** meaning only.
- **Amend the booking form:** collapse create/edit into one shared drawer.
- **Amend the Bookings page:** re-group into the money/action queue.

## 4. Required database / state-machine changes

The core change (D7/D8): **stop making `lead.status` mean five things.** Split into independent axes.

### New: `bookings` entity (one row per move; a lead can have several later — D8)
```
bookings
  id                uuid pk
  lead_id           uuid  -> leads (the client)
  date_certainty    enum('approximate','provisional','confirmed')   -- D7
  approx_window     text        -- e.g. "mid-August" (see open item)
  approx_month      date null   -- 1st-of-month, for grouping/sorting the demand panel
  provisional_date  date null
  confirmed_date    date null
  property_type     enum('homeowner','rented')                      -- D9 (date-flex)
  required_vans     int         -- from the accepted quote
  required_crew     int
  pack_date         date null   -- D10 (crew-only, usually confirmed_date - 1)
  pack_crew         int null
  notes             text
  -- money is NOT duplicated here; it is DERIVED from Payments Policy v2:
  --   deposit_status (£100), commitment_status (25%: not_due/due_soon/overdue/paid), balance_status
```
- **Off-diary until confirmed (D3):** an `approximate`/`provisional` booking is a `bookings` row only — no `appointments` row, so it consumes **no diary slot and no hard capacity**. On confirmation it materialises **exactly one** removal `appointment` on `confirmed_date` (+ an optional crew-only `pack` appointment on `pack_date`). This is the anti-duplicate invariant.
- **Capacity (D5):** Availability grading sums `required_vans/crew` of **confirmed** bookings per day vs live fleet. Provisional/approximate never counted as hard capacity (only surfaced in the panel / day summary).

### New: `staff.is_driver boolean` (D12)
- Single flag now (no licence classes). Assignment shows a **warn-only** flag when a job has ≥1 van assigned and 0 drivers among assigned crew. Never blocks save (mirrors `clashesFor`).

### `appointments` (existing) — minor
- Add `pack_of_booking uuid null` + allow `appt_type = 'pack'` (crew-only). The board already spans multi-day via `apptDays`; a pack appointment is just a crew-only single-day entry linked to the booking.

### `lead.status` (existing) — narrow its meaning
- Keeps the **sales** funnel only. `provisional`/`confirmed` as *sales* values can stay for continuity, but date certainty is read from `bookings.date_certainty`, not the lead. `lib/dashboard/compute.ts` funnel logic updated to read booking/appointment signals it already partly uses.

### Migrations, RLS, back-compat
- New migrations (cheap now — empty prod DB): `bookings`, `staff.is_driver`, `appointments.pack_of_booking` + `pack` type. RLS mirrors existing (office/admin write; crew read own assignments). A one-off backfill maps today's `provisional`/`confirmed` leads into `bookings` rows so nothing is orphaned.
- **State machine:** `approximate → provisional → confirmed` is forward-only via the booking drawer; `confirmed → (date change)` routes through the existing `ChangeDateDialog` (never a bare update). Deposit/commitment transitions stay owned by Payments Policy v2.

## 5. Suggested implementation phases

Each phase ships green (tsc + lint + vitest + build) and reviewed; each is independently revertible. **Phase 0 wants to land pre-go-live** while the DB is empty.

- **Phase 0 — schema + state machine (no UI).** `bookings`, `staff.is_driver`, `pack` appointment type; RLS; backfill; pure capacity/derivation functions (required-vs-fleet, driver check) with vitest. Nothing user-visible yet.
- **Phase 1 — the two-tab shell + Availability.** `/schedule` with shared `?date=`; month capacity grading (required-based); soft-demand panel + day summary; surveys off the board. Reads the Phase-0 model.
- **Phase 2 — Day Allocation (dispatch).** Single-day board: driver-aware crew, awaiting-crew, packing cards; reuse assign/clash/availability.
- **Phase 3 — shared booking drawer + Bookings queue.** One drawer from lead/bookings/availability/day; re-group the Bookings page into the money/action buckets.

Milestone previews at each phase (a live route to click), per the house TDD/preview rule.

## 6. Risks

| Area | Risk | Mitigation |
|---|---|---|
| **Payments / date changes** | Reshaping bookings accidentally forks or bypasses the 25%/refund logic we just hardened. | `bookings` **references** Payments Policy v2, never re-implements it. Every confirmed-date change still routes through `ChangeDateDialog`. No money field is duplicated on `bookings`. |
| **Duplicate appointments** | Provisional→Confirmed creates a *second* diary entry; or a lead ends up with two live moves. | Booking→appointment materialisation is **idempotent** (one confirmed booking ⇒ ≤1 removal appointment + ≤1 pack). One-booking-per-client invariant enforced until commercial multi-move is switched on. |
| **Capacity calc** | The two denominators (required vs assigned) blur, so the month lies about sellability; or provisional demand leaks into hard capacity; or off-by-one thresholds. | Pure, unit-tested capacity functions. Provisional/approximate **excluded** from hard capacity by construction (no appointment row). Thresholds are config + covered by tests. |
| **Go-live timing** | This is the core operational surface, changed right before launch. | Phase 0 is schema-only (invisible); UI phases land one at a time, each green + reviewed; the money paths are untouched. |
| **Empty-DB window** | Date-certainty/model change is cheap now, expensive once real bookings exist. | Do **Phase 0 before go-live**; UI phases can follow.

## Open items (need Peter)

1. **Capacity thresholds** — confirm the D6 lines against the live preview, and the fleet counts to model (real fleet is 2 vans / Luton 1–2; the mockup used 3 for spread). Thresholds are config, so this is a value, not a rebuild.
2. **Approximate-window capture** — proposed default: a **free-text label** ("mid-August") **+ a target month** (for grouping/sorting the demand panel); a structured date-range can come later. Confirm or redirect.
3. **Sequencing vs go-live** — Phase 0 pre-launch (recommended) vs the whole thing before launch vs after. (Originally teed up; now informed by the above.)
