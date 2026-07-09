# iMVE discovery — module clone & improve spec

Browser-driven research (2026-07-09) of the iMVE modules Marley Ops will replace or
absorb. Method: authenticated chrome-devtools walk of app.i-mve.com — accessibility
snapshots + screenshots of each page, every add/edit modal opened to capture the
data model, nothing saved. Login lives in `.env.local` (`MARLEY_IMVE_USER/PASS`).

The goal is NOT a 1:1 clone — it's to steal the proven logic, drop what Connor never
used, and build each module the marley-ops way (Supabase + RLS, server actions,
Marley design tokens, iPad-first).

---

## 1. Job Board (`/admin/job-board`) — enhance our Board/Schedule

### What iMVE has
- **Range switcher**: Today / 1 Week / 2 Week / 3 Week / 4 Week + prev/next arrows,
  month label. Week columns Mon→Sun.
- **Left resource rail** with STAFF / VEHICLE tabs: searchable roster of staff
  (avatar cards) and vehicles; totals at the bottom (1 STAFF, 0 VEHICLES). Cards
  **drag onto a job** to assign.
- **Per-day availability strip** at the top of every day column: `👥 1 · 🚚 0`
  (free staff / free vehicles). `0 +1` notation = none free, one partially booked.
  Clicking opens an **Availability popover**: "STAFF — 0 FREE, 1 PARTIAL: Connor
  Wass — Busy 12:00–13:00 · free before 12:00, after 13:00" and "VEHICLES — 0
  FREE". Partial availability is computed from that day's assignments.
- **Job cards** per day: Job ID, client name (links to job), job title, date range
  (multi-day jobs repeat on each spanned day with a 📅 marker), time window,
  from → to postcodes, status chip (CONFIRMED / MOVE DATE / SURVEY BOOKED), a
  **MOVE DATE button** (drag/move the job to another day), an **Assign
  Staff/Vehicle button** (modal picker as the non-drag alternative), and
  "Staff Assigned:" chips with an × to unassign.

### What we build (improvements in bold)
- New **/schedule/board** page (or evolve the existing removals calendar): week
  grid, Today/1–4-week switcher, prev/next.
- Data: `appointments` (already ours) + new `vehicles` table + new
  `appointment_assignments` (appointment_id, staff_id | vehicle_id) join table.
  Staff = existing `profiles`.
- Day header capacity strip: free/partial/busy counts for staff + vehicles,
  popover with per-resource free windows — **same partial-availability logic,
  computed server-side from assignments**.
- Assign via drag AND via modal (44px targets — modal is the iPad-reliable path,
  drag is the desktop nicety; iMVE has both, keep both).
- **Improvements**: clash warning when assigning an already-busy resource
  (iMVE lets you double-book silently); vehicle MOT/tax expiry badge on the
  vehicle chip (they hold the dates but don't surface them here); capacity strip
  also shows **crew required vs assigned** per job (we know vans+men from the
  quote's vehicle spec — iMVE doesn't connect quote → crew requirement).

---

## 2. Vehicles (`/admin/vehicle`) — new module

### iMVE data model (Add Vehicle modal, captured verbatim)
- **Basic**: Vehicle Type (HGV / Van / Car), Registration Number (required)
- **Dates**: Tax Due, MOT Due, Insurance Renewal, Last Service
- **Financial**: Cost Per Month (£), Monthly Payment Date, End of Term Date
- **Other**: Notes, Vehicle Images (multiple)
- List: card/table toggle + search. Separate **Vehicle Staff** setting = staff who
  receive **vehicle defect inspection reports** (drivers do walkaround checks).

### What we build
- `vehicles` table: name/callsign, type (luton / transit / 7.5t — OUR fleet
  vocabulary, not HGV/Van/Car), registration, tax_due, mot_due,
  insurance_renewal, last_service, cost_per_month, payment_day, end_of_term,
  notes, photos (Storage bucket), is_active.
- /vehicles page: cards with **traffic-light compliance chips** (MOT/tax/insurance
  due within 30 days = amber, overdue = red) — iMVE stores the dates but shows no
  urgency; we surface it. Feed due dates into Follow-ups as tasks (reuse the
  follow_ups engine — no separate reminder system).
- Vehicle day-rate already lives in Settings costs — link vehicle type → cost model
  so Performance margin maths can go per-vehicle later.
- Defer: defect-inspection reports (crew-facing) until crew logins exist.

---

## 3. Storage (`/admin/storage`) — new module (Connor has 1 test site)

### iMVE model (captured)
- **Sites** (locations): name, Google-Maps-linked address, ACTIVE badge, TOTAL /
  AVAILABLE unit counts, archive, per-site settings ("Plan Settings" = plan type).
- **Containers** per site: number (#1), name, **type** (250 Cube Crate / 20ft /
  40ft Shipping Container — configurable list), size ("39×7×7 = 1911 cu ft"),
  unique code (40FT-SC-650441), description, status Occupied/Available (derived
  from customer assignment). Duplicate button, CSV import, list/grid toggle,
  search + status filter.
- **Customers tab** per site: storage customers (who's in which container).
- **Site Plan**: drag-and-drop visual canvas (warehouse/office/road blocks +
  "add your own"), zoom/fit — a map of the yard with containers placed on it.
- Billing: recurring storage invoices (their Storage Analysis counts "Recurring
  Invoices Sent / Active Recurring Invoices"; separate storage
  invoice/receipt PDF customisation in Settings).

### What we build (phased)
- **Phase 1**: `storage_sites` + `storage_units` (site_id, number, name, type,
  size_cuft, code, description) + `storage_lets` (unit_id, client_id, lead_id?,
  start_date, end_date?, rate_per_week, notes) — occupancy derives from open lets.
  /storage page: site cards → unit list with Occupied/Available filter, assign a
  client to a unit (reuses client dedupe/search), free-text rate.
- **Phase 2**: recurring billing via the existing Zoho integration (recurring
  invoice or scheduled ensure-invoice cron — the never-create-twice pattern
  already exists). This was reviewed and deferred once already; storage revenue
  in Zoho stays manual until Peter calls it.
- **Skip for now**: the visual site-plan canvas (lovely, low value at 1 site) and
  CSV import. Revisit if Connor's storage side grows.

---

## 4. Staff, Settings & document templates (`/admin/profile`)

### iMVE settings tree (full menu, captured)
- Account: info, password. Company: info, site customisation.
- **Jobs & Pricing**: Job Fields Customisation, Job Status Customisation, Quote
  Pricing Templates, Detailed Costing, Cubic Calculator Fields, Job Sheet
  Customisation, **Job Sheet Templates**, Customer Acceptance, Company Sign off
  Templates.
- **Communications**: Email Templates (+ visual Builder), SMS Templates,
  **Email & SMS Automation**, Email Configuration.
- **Documents (PDF customisation, one page per doc type)**: Quote, Deposit
  Receipt, Deposit Invoice, Invoice, Invoice Receipt, Custom Invoice (+ Receipt),
  Storage Invoice / Receipt / Custom variants. Pattern: **live WYSIWYG preview of
  the real document + "Edit Template Text" + "Switch to Custom"**; footer carries
  Google/Facebook/Trustpilot review badges.
- **Staff**: Rota Settings, **Staff Management** (add = full name, email,
  password — a login that "can access assigned jobs", i.e. crew see their jobs),
  **Vehicle Staff** (recipients of defect reports).
- Misc: Integrations, Lead Provider Settings, Import/Export, Account Statement.

### What we take
- **Already ours, better**: email/SMS copy = Resend templates (dashboard-editable,
  publish-to-live) + the automation engine (chase/deposit/review crons). Their
  Email & SMS Automation validates our chase-engine design.
- **Worth adding — quote/invoice PDF text settings**: a small Settings block
  ("Document text") for the editable sentences on our quote PDF (intro line,
  terms footer, sign-off) stored in `business_settings`, with the live-preview
  pattern we already use for the quote PDF. Cheaper and safer than a full
  template builder.
- **Review badges on the quote email/PDF footer** (Google 5.0 etc.) — easy trust
  win, we have the review count in site config.
- **Staff logins for crew** (Connor/Luke already exist as users; a `crew` role
  that sees only their assigned day's jobs = the job-sheet mobile view) — this is
  the gateway to job sheets, sign-off and defect reports. Later phase.
- **Job sheet PDF** (their Job Sheet Templates): per-job crew sheet — addresses,
  inventory, access notes, customer signature. Natural extension of our existing
  pdfmake pipeline. Good candidate right after Vehicles.

---

## 5. Reports (`/admin/reports`) — Peter: "can work as a new page alongside Performance"

### Jobs Analysis dashboard (tabs: Overview / Sales / Ops / Finances)
- Date-range picker ("Last 30 Days" + explicit from–to).
- KPI cards **each with its definition printed under the number** (steal this):
  - Revenue Generated = accepted quote value, move date in range
  - Revenue Paid = invoices marked paid in range
  - Projected Revenue = accepted quotes sent in range
  - Potential Revenue = all quotes sent in range
  - Jobs Completed (move date in range), Conversion Rate (accepted ÷ total leads),
    Avg Job Value (revenue paid ÷ jobs paid), **Same-Day Quoting %** (quotes sent
    same day as survey — great ops metric).
- Quotations Overview: quoted / accepted / declined / no-response + conversion
  bar ("one quote counted per job" — dedupe rule printed).
- Job Status Performance: count per status, click-through to the filtered list.
- Lead Generators: jobs sourced per third-party platform (Pin Local, Getamover,
  Compare My Move, Really Moving).
- Overall (range-independent): Revenue Generated/Paid/Projected/Potential,
  this-month vs last-month paid, avg job value, surveys completed, Revenue by
  Year bars, Monthly Revenue Trend lines (last 3 years + current, per-year
  series).

### Storage Analysis dashboard (tabs: Overview / Invoice Analytics / ROI Calculator)
- KPIs: Total Locations, Total Containers, Available, Occupied (progress bar).
- Customer Analytics: active/archived storage customers, recurring invoices
  sent/active.
- Revenue Overview: total paid vs projected (unpaid) with invoice counts.
- ROI Calculator tab (container investment payback — nice-to-have).

### What we build
- Extend our **Performance** page with a date-range picker and a **Sales tab**:
  the four revenue definitions above map cleanly onto our data (agreed_price,
  Zoho paid stamps, quotes sent). Add Same-Day Quoting (survey completed_at →
  quote email_sent_at same UK day) and per-status click-through counts (we have
  the funnel + loss reasons already — ours is richer with "why we lose").
- Lead Generators ≈ our source attribution (organic/ads/meta/referral/manual) —
  already better; add a per-source revenue column.
- Storage analytics arrive WITH the storage module (occupancy %, paid vs unpaid).
- Keep it one Performance page with tabs, not a separate dash — fewer surfaces.

---

## Suggested build order

1. **Vehicles** (small, self-contained; unblocks Job Board resources + compliance chips)
2. **Job Board v2** (week board + capacity strip + assignment; the daily driver)
3. **Performance: Sales tab + date range** (pure read models, no migration risk)
4. **Job sheet PDF + crew role** (crew logins → assigned-jobs view → sign-off)
5. **Storage phase 1** (sites/units/lets; billing manual in Zoho)
6. Storage billing automation + reports, defect reports, PDF text settings (as needed)

Each gets the usual gate: migration → tsc/tests/build → deploy → live UI verify.
