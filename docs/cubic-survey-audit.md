# Cubic survey — iMVE audit + marley-ops implementation plan

Audited 2026-07-10 (authenticated browser walk of app.i-mve.com as Connor W. admin,
plus their API). Companion to `imve-discovery.md`. Full item catalogue extracted to
**`imve-cubic-catalogue.json`** (7 categories, 218 items, every cu ft value).

---

## 1. What iMVE has (full audit)

### Access & flow
- **View Job → "Cubic Sheet Details"** section with two actions:
  **"+ Add cubic sheet"** → admin form at `/admin/addcubicsheet/<jobId>`, and
  **"Copy cubic sheet URL"** → PUBLIC form at `/addcubicsheet/<jobId>` —
  **no login required**; the customer self-completes their inventory. (The public
  page also displays the customer's name, phone and both addresses to anyone
  holding the URL — a privacy hole we must not copy.)
- The job record stores `cubicvalue` (the total, shown in the job header as
  "Cubic Ft: N/A" until set) and `cubicfiles` (attachments).

### The form
- **7 room-category chips**: Living space (75 items) · Loft (5) · Bedrooms (39) ·
  Garage/garden area (53) · Kitchen and utility (26) · Office and commercial (20)
  · Other (0 — empty, no custom-add UI; dead tab).
- Each item renders as a card: `Title - <cuft>` with **− / qty / +** steppers.
- **Search box** filters items across every category (e.g. "piano" → Piano
  upright 70 / Baby grand 80 / Grand 150 / Piano stool 4).
- **Added items list**, grouped by category, each line with **editable qty** and
  **editable per-unit "Cubic Ft (approx)"**.
- **Additional Details** textarea + **Photos & Files** multi-upload (admin form
  only; the public customer form has no file upload).
- Catalogue is per-company configurable in **Settings → Cubic Calculator Fields**
  ("Define items and their cubic footage values used in volume calculations";
  Add Category; table of TITLE | FT³/M³ VALUE; items carry an `priceedit` flag
  and sort order).

### The measurements (extract — full list in `imve-cubic-catalogue.json`)
Representative values Connor's account uses (ft³): Sofa 2/3/4-seater 35/50/65 ·
Corner sofa 3/4-seater 103/140 · Welsh dresser 80 · Piano upright/baby
grand/grand 70/80/150 · Divan single/double/king/super-king (incl. mattress)
40/55/60/72 · Wardrobe single/double/triple 25/40/60 · Fridge-freezer 50 ·
American fridge-freezer 80 · Chest freezer 70 · Single garage half/full 400/800 ·
6x4 / 12x8 shed 140/280 · Trampoline 70 · Ride-on mower 125 · Multi-gym 120 ·
Photocopier 60 · Meeting table 160 · boxes: Medium 2 / Large 4 / Wardrobe box 6 /
Already boxed 3 / Sundry 1. Every category ends with the box/sundry set so
surveys capture loose volume.

### What iMVE does NOT do (the gaps we beat)
1. **No live running total** — the form shows nothing until you save; no
   per-room subtotals either.
2. **No van conversion** — total ft³ never becomes "how many Lutons"; the loop
   into quoting/resourcing is never closed (their job header just prints the
   number).
3. **No quote integration** — vehicle spec on the quote is chosen by gut, the
   cubic sheet doesn't inform it.
4. **Unauthenticated public link exposing PII.**
5. **No ad-hoc custom item** from the form (only via Settings; "Other" tab is
   empty and does nothing).
6. **No per-item flags** a surveyor actually needs (dismantle/reassemble,
   fragile/high-value, "not moving", owner-packs).
7. **Nothing reaches the crew** — job sheets carry none of it.
8. **Proof it fails in the field: 0 of Connor's 67 iMVE jobs have a cubic
   value.** The team has never completed one. Whatever we build must be faster
   than a paper pad on a phone, or it will suffer the same fate.

---

## 2. Marley-ops implementation plan

**Positioning:** an OPTIONAL volume survey attached to the lead (Peter,
2026-07-10: "this would be an option"). Primary user = Connor/Luke on a phone or
tablet mid-survey; secondary = customer self-completion via token link (their
best idea, done safely). The output feeds the quote's vehicle spec — the loop
iMVE never closes.

### Data model (migration 0029)
- **`cubic_surveys`** — one live sheet per lead (partial unique on lead_id):
  `id · lead_id (set null) · client_id (set null) · appointment_id (set null)` —
  triple-anchored like job_notes/evidence so it survives diary changes;
  `items jsonb` = `[{ key, title, category, qty, unit_ft3, note? }]` (catalogue
  items AND custom one-offs share the shape — a custom item is just
  `key:"custom-<uuid>"`); `total_ft3 numeric` (denormalised for lists/quote
  chip); `notes text`; `status` `draft | complete | customer_submitted`;
  `share_token` (unique, minted lazily — /q & /s pattern);
  `created_by / updated_by / timestamps`.
- RLS: read+write `is_staff()` (crew CAN survey — no money here), delete admin.
- Photos: reuse the existing **survey-photos pipeline** (extend
  `survey_photos.category` check with `'cubic'`) — no new bucket.
- **Catalogue = code, not DB**: `lib/cubic-catalogue.ts`, seeded verbatim from
  `imve-cubic-catalogue.json` (all 218 items — Peter: "we need all the
  measurements they have"), tested for integrity (no dupes per category, all
  values > 0). Per-line overrides + custom items cover the day-to-day; a
  Settings editor is phase 3 only if Connor ever asks.
- **Vehicle capacities in Settings** (business_settings): usable ft³ per
  vehicle class — defaults **Luton 550 · Transit 280 · 7.5t 1,400** — so the van
  maths uses Marley's fleet, editable without deploy.

### The builder (`/leads/[id]/cubic` — phone-first, one screen)
- **Search-first**: big search box at top (fastest field pattern), category
  chips underneath; one tap adds an item, steppers adjust; recently-added stay
  visible.
- **Sticky live total bar** (the headline improvement): running **total ft³ +
  van conversion** — "812 ft³ ≈ 1.5 Luton loads → recommend 2 Lutons" with a
  fill bar. Updates on every tap. Per-category subtotals in the added list.
- Added list: qty + editable unit ft³ (iMVE parity) **+ per-line flags:
  dismantle · fragile/high-value · not moving** (excluded from the total but
  recorded) + optional line note.
- **Custom item row**: name + ft³ + qty inline ("Other" done properly).
- Photos (existing capture component) + general notes.
- Autosave draft on change; "Mark complete" stamps it. Office AND crew can use
  it (a surveyor on the doorstep is the point).

### Where it surfaces
- **Lead page**: Survey tab card — total, van recommendation, item count,
  open/edit, copy customer link.
- **Quote wizard**: when the lead has a sheet, a chip beside vehicle selection —
  "Survey volume 812 ft³ → suggests 2 Lutons" — **pre-selects on NEW quotes,
  suggests-only on existing** (never silently change a priced quote).
- **Job sheet PDF + /my-jobs**: one line — total ft³ + dismantle/fragile flags
  (price-free by construction, no invariant risk).
- **Customer self-completion** (phase 2): `/cv/<token>` public page, noindex,
  unguessable token, shows ONLY first name + the builder (no address/phone —
  fixes iMVE's leak), no internal flags/notes; submit → status
  `customer_submitted` + ops alert + lead activity; office reviews and adjusts.
  Email/SMS send via existing comms with a Resend template.

### Build order (each milestone prod-E2E'd)
1. **M1 — core builder + quote loop** (the value): migration, catalogue lib +
   tests (totals, van maths, rounding, mixed fleet), builder page, lead card,
   quote-wizard chip, job-sheet line.
2. **M2 — customer link**: token page + email template + review flow.
3. **M3 (only if asked)**: Settings catalogue editor; m³ display toggle.

### Open decisions for Peter
1. **Van recommendation → quote**: pre-select vehicles on a new quote (my
   recommendation) or display-only chip?
2. **Customer self-fill link in v1?** It's iMVE's one good idea and cheap once
   the builder exists — I'd ship it as M2 in the same pass.
3. **Room-level grouping** (Bedroom 1/2/3…): iMVE doesn't have it; adds taps.
   I'd skip for v1 — categories + notes cover it.
