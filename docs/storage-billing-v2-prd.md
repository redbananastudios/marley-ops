# Storage Billing v2 — rate card, crate daily-arrears model, handling events

**Status:** standing policy declared by Peter 22 Jul 2026 (forwarded cost/rate
analysis, "make sure ops is aligned to this billing"). Builds on storage billing
phase 2 (0027). Companion: `docs/policy-confirmation-for-terms.md` §B (customer
terms), `docs/terms-review-inputs.md`.

> **Amendment (2026-09-02, storage-terms v2 2026-08-31 / commit 1038f96):** the
> crate minimum below is superseded for NEW lets. The published terms now say
> "a minimum period of one calendar month", with to-the-day charging only after
> that month ends. `storage_lets.min_kind` (migration 0115) freezes the rule
> per let: `calendar_month` for lets created under v2 terms (clamped
> anniversary: 15 Sep → covered through 14 Oct; 31 Jan → 27/28 Feb), `days`
> for legacy/imported lets, which keep the frozen `min_days` window described
> in this document. `lib/storage-billing.ts` `crateMinimumEnd` is the single
> derivation; `crateMinimumLabel` keeps the signed ack wording in step.

## 1. The standing policy (customer side)

Two products. All customer-facing figures **gross (VAT-inclusive)**; Zoho
itemises the VAT.

**Container** — £290 ex / **£348 inc per calendar month**.
- Billed monthly **in advance**; first month at commencement (anniversary
  anchor — the existing monthly engine, month-end clamped).
- End any time; **final month bills in full, no pro-rata**.
- One customer per container (already enforced: one open let per unit).
- **No handling fees.**

**Crate** — £17.50 ex / £21 inc per week ⇒ day rate **£2.50 ex / £3 inc** (÷7).
- **28-day minimum, invoiced upfront** at commencement: £70 ex / **£84 inc**
  (2 days' use still pays £84).
- **Day 29+ charged to the exact day, in arrears, on a 4-weekly (28-day) cycle.**
- **Handling: per crate per event** (in and out, and any mid-let access):
  £50 ex / **£60 inc** — a straight pass-through of Sandys' charge, see D1.
- **Release:** final invoice = unbilled days + egress handling (+ redelivery
  quoted as a normal transport job) — **settled before goods leave**.
- Charges accrue until goods physically leave (departure day is chargeable).
- Release by appointment, subject to availability — no notice promise. Access
  only ever through Marley.

**Both products:**
- Arrears: 60+ days unpaid → written notice → statutory 3-month minimum →
  sale, surplus returned (≈5-month disposal timeline). Manual flow; terms carry it.
- Price changes: 30 days' written notice, free exit before effect.

**Cost side (ops only, FRS — no input VAT recovery, all supplier costs gross):**
- Containers fixed: £174 gross/month × containers held (2) regardless of occupancy
  → utilisation is the metric.
- Crates variable: Σ(crate-days × £1.7143 gross) + (events × £60 gross),
  reconciled monthly against the Sandys invoice.
- Storage income to its own income line, separate from Removals Income (D4).

## 2. Decisions taken in this build (flag list for Peter)

- **D1 — handling charge £50 ex / £60 inc — Peter's FINAL call, 22 Jul 2026:
  a straight pass-through of Sandys' charge, deliberately no markup.** This
  supersedes the same-day £72 confirmation. The FRS consequence was flagged and
  accepted: we keep ~£54.60 of the customer's £60 but pay Sandys £60 gross, so
  each event loses ~£5.40 (~£6.00 at 10% FRS); break-even would be £55 ex/£66
  inc. Lives in Settings → Storage rates (DB set to 60 on prod + dev, 22 Jul —
  the 0075 seed was 72), editable without deploy; the crate ack wording renders
  the live figure.
- **D2 — FRS % NOT changed.** The analysis assumes 9% to 31 May 2027; ops
  Finance is set to 10% and the first-year-discount question is still with the
  accountant (go-live checklist). Flip in Settings → VAT scheme when confirmed.
- **D3 — "calendar month" = anniversary month** (first month runs from
  commencement day, clamped for short months) — matches "first month at
  commencement" and the shipped engine. Not calendar-aligned proration.
- **D4 — income separation via Zoho line-item name "Storage"** on every storage
  invoice. Zoho *Invoice* has no chart of accounts (that's Books) — the item
  name is the mapping handle for the accountant.
- **D5 — crate ack label** is framed as a first-person agreement around Peter's
  wording: "I agree to the crate storage terms: 28-day minimum, then charged to
  the day; handling £72 inc VAT per crate in and out; all charges settled
  before release." Solicitor should confirm alongside the terms clause.
- **D6 — supplier facts CONFIRMED by Peter 22 Jul 2026**: £145 ex VAT is per
  container and payable on both (£174 gross × 2 fixed monthly cost); Sandys
  imposes no minimum on us (crate cost accrues purely per day). Matches the
  seeded cost card exactly — nothing changed.

## 3. Data model — migration 0075

- `storage_lets`: `billing_model text not null default 'period'`
  (`period` | `crate_daily`), `min_days int`, `min_amount numeric(10,2)`
  (frozen at let creation from the rate card so later card edits never disturb
  a running let). `rate_period` check widened to `('week','month','day')`.
- `storage_handling_events`: id, let_id (restrict), client_id, `event_date`,
  `kind` (`in` | `out` | `access`), `amount` (frozen at record time), notes,
  `billed_invoice_id` → storage_invoices (set on successful billing),
  created_by, created_at. RLS `is_office()` (money table).
- `storage_invoices`: `kind text default 'period'`
  (`period` | `minimum` | `arrears` | `final`), `handling_amount numeric(10,2)
  not null default 0` (portion of `amount` that is handling — feeds cost
  reconciliation).
- `business_settings.storage_rates jsonb` seeded:
  `{container_month_inc:348, crate_week_inc:21, crate_day_inc:3,
    crate_min_days:28, crate_min_inc:84, handling_event_inc:72,
    supplier:{container_month_cost:174, containers_count:2,
    crate_day_cost:1.7143, handling_event_cost:60}}`

## 4. Engine (pure, `lib/storage-billing.ts`)

Router = `billing_model`. `period` lets keep the shipped engine untouched.

`crate_daily` periods:
- **minimum**: `[start, start+min_days−1]`, amount = `min_amount`, due in
  advance once `today ≥ start`. Never truncated by end_date (that's the point
  of a minimum).
- **arrears cycles**: 28-day windows from `start+min_days`; truncated at
  `end_date`; amount = inclusive days × day rate; due the day AFTER the window
  completes — or immediately once `end_date` is set (release settlement:
  "settled before goods leave").
- **handling sweep**: unbilled events with `event_date ≤ period_end` ride the
  invoice being raised (deterministic — retry after a crash recomputes the same
  set, so orphan adoption amounts match). Events are marked billed only after
  the invoice write-back succeeds.
- **handling-only final**: if `end_date` is set, no period remains due, and
  unbilled events exist (e.g. released inside the minimum window — day charges
  covered, egress isn't), raise a `final` invoice for the events alone. Claim
  key `period_start = end_date + 1 day` (cycle starts can never land there, so
  the unique(let_id, period_start) claim can't collide — including the
  same-day-release edge where `end_date = start_date`).

Never-create-twice unchanged: unique(let_id, period_start) DB claim +
`MMS-<let8>-<period>` Zoho reference adoption + release-claim-on-failure.

## 5. Flows

- **Start crate let**: rate/min frozen from the card; optional (default ON)
  "record handling in" event dated start. Container lets default the monthly
  card rate.
- **Record handling event** (Manage dialog): kind in/out/access, date, amount
  pre-filled from card, notes. Bills on the next raised invoice.
- **Release (end let)**: end date + (crate) egress-handling toggle default ON →
  records the `out` event, sets `end_date`, then **bills the let immediately
  inline** (shared core with the cron) so the final invoice exists before goods
  leave. UI shows what was raised.
- **Cron** (daily, unchanged schedule): same loop, now routed per model, sweeps
  handling, stamps `kind`/`handling_amount`, passes item name "Storage".

## 6. Cost tracking (Performance → Storage)

"Supplier cost — this month" card: containers_count × container_month_cost +
crate-days in month (actual days per crate let, capped at end/today) ×
crate_day_cost + handling events in month × handling_event_cost. Shown beside
billed revenue for the month → true-margin eyeball + the monthly Sandys
reconciliation number. Container utilisation % (occupied/total container units).

## 7. Out of scope (manual / terms-only)

- Disposal flow (60d → notice → 3-month statutory → sale) — manual; terms carry it.
- Price-change notices (30 days, free exit) — manual comms.
- Redelivery/collection — quoted as a normal transport job through the quote flow.
- Zoho income ACCOUNT mapping (Books concept) — accountant maps by item "Storage".

## 8. Hardening (2026-07-22, migration 0076 — pre-go-live review sweep)

A three-lens review (money / security-RLS / concurrency) plus a 15-agent
adversarial verification pass hardened the v2 ship. Everything below is live:

- **Ledger reads are strict + paged** (`fetchAllRows`, no 1000-row cap, no
  long `in.()` URLs): any read failure sets `RaiseSummary.fatal` and NOTHING
  raises — surfaced as a money alert by the cron and an unverified-settlement
  warning on release.
- **Claims record their swept events** (`storage_invoices.handling_event_ids`);
  marking and the repair sweep use the stored set, and the raise NEVER
  re-sweeps an event already on any claim row — closes the crash/double-sweep
  class. Zoho **orphan adoption verifies the amount** (±£0.005;
  `classifyPendingClaim`) — a mismatch alerts and never adopts.
- **`repairPendingStorageClaims`**: pending claims >1h old are adopted
  (write-back + marks + deduped email), released, or alerted — run by the
  daily cron before the raise AND (let-scoped) by the release flow.
- **Cron alerts**: fatal ledger failure (money), non-fatal errors incl. email
  sends (system), stranded unbilled events on lets ended >3 days (money), and
  the stranded check's own failure (system).
- **Action guards**: crate reopen blocked once any invoice exists (fail-closed
  on the count read); handling events only on OPEN crate lets, dated
  start..today; crate lets must always carry a positive day rate (start AND
  edit); crate day rate locks once invoiced (UI mirrors it); the release's
  overbilled note fires ONLY for crate arrears/final windows past the end date
  (minimum + period lets bill in full by policy — no false credit-note
  prompts); `deleteHandlingEventAction` is atomic (`billed_invoice_id IS
  NULL` predicate + rowcount) and honest about why a delete didn't happen.
- **RLS (0076)**: events UPDATE policy dropped (no app path — pure tamper
  surface); events DELETE = office + unbilled; events INSERT pins
  `created_by = auth.uid()`; `check (amount > 0)` + min_days/handling_amount
  checks; **storage_invoices office INSERT/UPDATE dropped** (claims are
  service-role-authored only — a fake/patched claim was the same tamper class).
- **Supplier costs are admin-only end to end**: moved to the RLS-gated
  `storage_supplier_rates` singleton and the server-side-only
  `lib/storage-supplier.ts` (never value-imported client-side); Performance
  hides the cost card for estimators; the Settings card refuses to render on a
  failed read (a save over silently-defaulted figures would overwrite the
  real card).
- **Signature evidence**: `signatures.ack_labels` stores the rendered ack
  wording (the crate ack quotes live rate-card figures) on both signing paths.
- Verified: 1135 vitest + e2e storage spec + live dev-server cron smoke
  (minimum £144 = £84 + £60 swept ingress, event marked, idempotent re-fire).

Accepted residuals (documented, not bugs): ack labels are re-derived server-
side at submit (a rate edit in the seconds between render and sign can differ
— capture-from-client would be spoofable); repair has no mutex against a
manually-fired overlapping cron (worst case one duplicate email); a crate rate
remains editable before the first invoice by design.
