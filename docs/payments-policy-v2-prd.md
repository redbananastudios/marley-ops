# Payments Policy v2 — deposit commitment ladder + refund queue (PRD)

**Status:** locked with Peter + Connor 21 Jul 2026 (chat), simplified from the original
brief (marley-ops-payments-policy-brief.md). System is UNUSED pre-launch, so this is
built as THE policy — **no version gating, no v1 grandfathering machinery**. The only
external dependency: the reviewed T&Cs (with the date-confirmation clause) must be
published on marleymoves.co.uk before the first real customer signs — tracked in the
go-live checklist A3 + `docs/terms-review-inputs.md`.

## 1. The locked policy (plain English, confirmed by Peter)

Example: £2,400 job, £100 deposit.

1. Customer accepts the quote and pays the **£100 deposit** → booking secured.
   £100 **fully refundable** at this point, unconditionally.
2. Customer **confirms their move date** (tick + sign on /q, or office collects it
   in person / by link). From that moment the deposit is **non-refundable**.
3. Date confirmation raises a second invoice: **25% of the gross price minus the
   deposit** (£500 here), due **7 days before the move**. If confirmation happens
   later than move−7d, it's due immediately (late collapse).
4. Balance (gross − 25%) due **in full before move day, full stop**.

**Cancellation:** before date confirmation → full refund, always. After → we hold
what's paid (capped at 25% of gross); one question decides: **did the old day
re-book?** Re-booked → everything refunded. Stayed empty → up to 25% retained,
anything above 25% refunded regardless.

**Date change:** >7 days out → free, everything rolls (dates, invoices, held money),
booking stays confirmed. Inside 7 days → the old date is cancelled (fill rule applies
to it) and a new date is booked on the **same lead + same quote** — **no second £100
is ever taken**: held money provisionally counts toward the new booking. If the old
day later dies unfilled, the retained amount stops counting and the queue entry
states the shortfall for a manual balance adjustment.

**Marley cancels/moves it:** full refund of everything, immediately, no fill question.

**Hard copy rule:** the word **"penalty" never appears** — terms, /q, emails, UI.
Framing is always "held against your original date — refunded in full if we re-book
it." (Test-enforced, like the price-free job-sheet invariant.)

**Rails:** deposit/commitment/balance payable by card (takepayments), bank transfer,
or cash. Card fees absorbed, never surcharged, never deducted from refunds. Refunds
return via the **original rail**: card → same card via takepayments (in-ops); transfer
→ originating account; cash → bank transfer to a named account collected on the queue
entry.

## 2. Deliberately DEFERRED (agreed with Peter — keep it simple)

- **Automatic fill detection** — no watcher/candidate matching. The queue row asks
  the human "did we re-book <date>?"; Connor answers from his own diary.
- 5-working-day escalation emails + badges (keep the one accounts@ alert on creation).
- Automatic Zoho credit notes (raised manually from the row's invoice links).
- Quote-supersession commitment recompute — superseding a quote that carries a
  commitment invoice fires an ops alert "adjust commitment invoice manually"; no
  automated delta invoice.
- Automated shortfall re-invoicing after a forfeit on a rebooked job — the queue row
  states the shortfall; office adjusts the balance invoice by hand.
- Customer re-signature on an inside-window date change — the original confirmation
  ack + warning dialog cover it; a re-confirmation link is a possible later nicety
  (flag for the solicitor).

## 3. Policy engine — `lib/payments-policy.ts` (pure, fully unit-tested)

```
COMMITMENT_PCT = 0.25                 // of VAT-inclusive agreed price
COMMITMENT_DUE_DAYS_BEFORE = 7
CONFIRM_CALL_DAYS_BEFORE = 10         // T-10 human call task
REFUND_CUSTOMER_SLA_DAYS = 14         // stated in emails
```

Functions (all take/return plain values; UK wall-clock day maths via the existing
`ukDayOf` pattern — never raw UTC dates):

- `commitmentAmount(grossAgreed, depositAmount)` → `max(0, round2(0.25×gross − deposit))`.
  (Deposit is the ACTUAL deposit on the quote — office can override £100 — not a constant.)
- `commitmentDueDate(moveDate, today)` → `moveDate − 7d`, clamped to `today` (late collapse).
- `isInsideChangeWindow(moveDate, today)` → true iff UK-calendar days until move `< 7`.
  Boundary: exactly 7 days out = OUTSIDE (free change). Test-locked both sides.
- `splitHeldMoney(payments[], grossAgreed)` → `{conditional, unconditional}` where
  conditional = first 25%×gross of payments in chronological order, unconditional =
  the remainder (always refunded regardless of fill). Returns per-rail allocations so
  the queue can show "£100 card + £250 of £350 bank held; £100 bank unconditional".
- `refundOutcome(determination, split)` → amounts to refund/retain per rail.

## 4. Data model — migration 0073

**`leads`:** `date_confirmed_at timestamptz`, `date_confirm_signature_id uuid
references signatures(id)`. Deposit refundability is DERIVED (null = refundable) —
no boolean to drift.

**`quotes`:** `zoho_commitment_invoice_id text` (doubles as the never-create-twice
claim, exactly like the -DEP/-BAL columns), `commitment_amount numeric(10,2)` (frozen
at raise), `commitment_due_date date`, `commitment_paid_at timestamptz`,
`commitment_chase_t10_at timestamptz`, `date_releasable_at timestamptz` (T-7 flag —
a discretion marker, never an automatic release).

**`refund_queue`** (new table):
```
id uuid pk, created_at, lead_id, quote_id, old_appointment_id, new_appointment_id,
original_move_date date, trigger text check in
  ('customer_cancel','customer_date_change','marley_cancel'),
held jsonb            -- [{rail:'card'|'bank_transfer'|'cash', amount, card_payment_id?, zoho_invoice_id?}]
conditional_amount numeric(10,2), unconditional_amount numeric(10,2),
determination text check in ('filled','not_filled') null,   -- null until the human answers; marley_cancel rows skip it
determined_by uuid references profiles, determined_at timestamptz,
status text check in ('pending','refunded','retained') default 'pending',
executed_by uuid references profiles, executed_at timestamptz,
shortfall_note text,          -- rebook forfeit: what the new booking now under-credits
cash_recipient_name text, cash_recipient_sort text, cash_recipient_account text,
notes text
```
RLS: `is_office()` read; writes via server actions only (service role) with office
gates — mirror the card_payments pattern. Crew/estimator: zero rows.

**Zoho:** commitment invoice reference = `<quoteRef>-COM`, slotted into the existing
orphan-adoption + stale-claim machinery beside -DEP/-BAL.

## 5. Flows

### A. Date confirmation
- **/q payment view** (deposit already paid): "Confirm your move date" card — shows
  the move date, the `DATE_CONFIRM_ACK` tick, typed-name signature → public action
  (token-authed): validate (deposit paid, move date set, not already confirmed) →
  insert signature (in-person variant mirrors the crew-tablet collect flow) → stamp
  `date_confirmed_at` + signature id → `ensureCommitmentInvoice` (claim pattern,
  -COM ref, due per policy) → date-confirmation email with the invoice attached →
  lead timeline activity + ops alert.
- **Office surfaces:** lead page + /bookings booked rows get a "Date confirmed ✓ /
  Not confirmed" chip with "Copy confirmation link" (the /q URL) and "Confirm in
  person" (dialog: ack + typed/drawn signature, channel in_person).
- Zero-commitment edge: 25%×gross ≤ deposit → NO commitment invoice is raised
  (nothing due); confirmation still flips non-refundability. Test-locked.

`DATE_CONFIRM_ACK` (lib/signatures.ts — wording provisional pending solicitor; the
ack string and the published clause must always change in the same commit):
> "I'm confirming this move date. I understand my deposit is now non-refundable and
> still counts towards my final bill. If I later cancel or move this date within 7
> days of the move and Marley Moves cannot re-book the day, amounts I've paid up to
> 25% of my job price may be retained — and are refunded in full if the day is
> re-booked."

### B. Commitment chases + balance
- Chase cron additions (same idempotency style as existing steps):
  - **T-10** (move−10d, commitment unpaid): call task "Confirm the date + chase
    commitment" + commitment-chase email (carries the inside-7-day warning verbatim).
    If the date is NOT yet confirmed at T-10: call task to get confirmation instead.
  - **T-7** (move−7d, still unpaid): stamp `date_releasable_at` → dashboard
    needs-action card "Dates at risk" — discretion state, release is a manual
    cancel with the standard customer-cancel treatment.
- **Balance invoice** now computes `agreed − (deposit paid + commitment paid)`.
- Late collapse: confirmation inside move−7d → due today, T-10 skipped, T-7 only if
  it stays unpaid.

### C. Cancel / date change (single path)
- **Change, outside window:** existing reschedule recompute (quote.moving_date,
  balance follow-up) + recompute `commitment_due_date` + confirmation email restating
  held amounts. No queue entry. Stays confirmed.
- **Change, inside window:** office dialog shows the warning copy verbatim + requires
  a tick → old removal appointment → cancelled (snapshot), new appointment on the
  new date, quote.moving_date updated, commitment due recomputed, **refund_queue row**
  (trigger customer_date_change, old date, held-money snapshot, linked new
  appointment). No new deposit is requested. Cancellation-ack email.
- **Customer cancels outright:** wire into the existing mark-lost unwind — when money
  is held, create the refund_queue row (replaces the old "refund decision" follow-up
  task; keep the ops alert): pre-confirmation → row with determination pre-set
  (unconditional, straight to refund); post-confirmation → conditional row.
- **Marley cancels:** trigger option in the cancel dialog → unconditional row, no
  fill question, apology email.
- Every branch logs a lead-timeline activity.

### D. /refunds page (Finance nav, office-gated SERVER-SIDE — page + every action)
- Rows appear automatically (C). Sections: **Needs decision** (conditional rows:
  "Did we re-book <date>?" → Filled / Not filled; early "Filled" allowed any time,
  "Not filled" only once the date has passed), **To execute** (determined +
  unconditional rows: per-rail amounts with Refund controls), **History**.
- **Card rail:** in-ops takepayments refund reusing the existing atomic
  reserve/lockout — armed by **re-typing the exact amount** (double validation).
- **Bank/cash rails:** operator makes the bank payment, then "Mark refunded" (also
  amount-retype-armed); cash rows first collect recipient name/sort/account.
- Row completes → ONE refund-executed email (all rails itemised). **Retained** press
  → retained-outcome email ("held against your date" framing, itemises anything
  refunded above 25%) — no credit note (HMRC forfeited-deposit position: retained
  sums keep their VAT; FRS counts them as turnover).
- accounts@ alert on row creation (reuse `OPS_ALERT_EMAIL_MONEY`); dashboard
  needs-action card "Refunds waiting (N)".

### E. Emails — 7 new templates (registry + in-repo fallback builders, house shell)
date-confirmation · commitment-chase · cancellation-ack · refund-executed ·
retained-outcome · marley-cancel-refund · date-change-confirmation (outside window).
All restate amounts gross. Refund emails state the 14-day SLA. A test walks every
template/builder/UI string asserting **"penalty" appears nowhere** (case-insensitive).

## 6. Acceptance criteria

- [ ] Deposit refund guidance derives from `date_confirmed_at` (null = refundable).
- [ ] Commitment maths: 25%−deposit, £0-invoice suppression, late collapse, due-date
      recompute on outside-window change. All unit-tested.
- [ ] Inside-window change: cancelled old appt + snapshot + linked new appt +
      queue row; NO new deposit invoice raised.
- [ ] Cancel with money held always creates exactly one queue row; nothing clears
      without a button press; determination + execution record who/when.
- [ ] Above-25% money always lands in `unconditional_amount` regardless of fill.
- [ ] Marley-cancel rows skip determination and refund everything.
- [ ] Card refund only executes after the typed-amount check matches exactly.
- [ ] Refunded → one email + terminal row; Retained → email + terminal row.
- [ ] "penalty" grep-test green across comms + UI.
- [ ] All customer-facing amounts gross. 
- [ ] Full existing suite stays green; new flows carry their own tests.

## 7. Build decomposition (file ownership — builders MUST stay in lane)

- **Foundation (first, alone):** migration 0073, database.types.ts, lib/payments-policy.ts
  (+tests), signatures.ts DATE_CONFIRM_ACK, lib/refunds.ts (queue-row create helper +
  held-money snapshot builder + tests).
- **Wave 1 (parallel): A** date-confirmation (/q card + public/in-person actions +
  `ensureCommitmentInvoice` in zoho.ts + lead-page chip component + template A).
  **B** chases + balance (cron file, balance flow, "Dates at risk" card component,
  template B).
- **Wave 2 (parallel): C** cancel/change (dialogs + actions + mark-lost wiring +
  queue-row creation + templates C/F/G). **D** /refunds page + refund actions +
  accounts@ alert + "Refunds waiting" card component + nav entry + templates D/E.
- **Integration (last, alone):** mount the four card/chip components on the
  dashboard/lead/bookings pages, register all templates in
  scripts/create-resend-templates.mjs, run tsc/lint/vitest/build, fix seams.
- Shared files each builder may NOT touch outside its lane: database.types.ts +
  signatures.ts (foundation only), zoho.ts (A only), chase cron (B only), mark-lost
  action (C only), dashboard/lead/bookings pages + templates registry (integration only).

## 8. Code-binding notes (verified against master by the 4-scout pass, 2026-07-21)

Full line-accurate maps live in the session scratchpad (`scout-accept.md`, `scout-chase.md`,
`scout-cancel.md`, `scout-zoho.md`) — builders MUST read their lane's scout file(s).
The decisions they bound:

1. **signatures.kind CHECK is closed-world** (`'contract','storage'`) — 0073 widens it
   with `'date_confirm'` + a partial unique index `on signatures(quote_id) where
   kind='date_confirm'` (double-submit guard). Follow the `/s/[token]` storage-agreement
   flow as the template (token page, 23505-tolerant insert, ops alert).
2. **Ladder state:** `leads.date_confirmed_at` (+ signature id) — a flag column, NOT a
   FUNNEL status (the FUNNEL array is index-compared in 3 places; do not touch it).
3. **Commitment invoice** mirrors deposit exactly: quotes columns
   (`zoho_commitment_invoice_id/number/url`, `commitment_invoice_amount`,
   `commitment_invoice_created_at`, `zoho_commitment_error`, `commitment_paid_at`,
   `commitment_paid_method`, `commitment_chase_t10_at`, `date_releasable_at`),
   `commitmentReference() = \`${ref}-COM\``, `ensureCommitmentInvoice` beside
   `ensureDepositInvoice`, a third branch in `supersedeSiblingQuotes` (void unpaid /
   alert on paid), a third poll in `syncZohoPayments`, and the zoho-deposits cron's
   stale-claim sweep + open-invoice query extended. `markCommitmentPaid` mirrors
   `markDepositPaid` (CAS on `commitment_paid_at`, Zoho record, email, follow-up close).
4. **Commitment + balance stay BACS/cash** (`disableOnlinePayments: true`) — card
   remains deposit-only for now (the card machinery is deposit-shaped: one-pending-
   per-quote, kind check). Card-for-commitment is a flagged fast-follow, NOT in scope.
5. **T-10/T-7 rides inside the existing daily chase cron** (no new VPS crontab line).
   Idempotency = stamp columns on quotes, stamped ONLY after the send/insert succeeds
   (fleet-reminders' record-after-delivery rule). follow_ups uses reason `'custom'` +
   `source:'commitment_chase'` + metadata (the reason enum is NOT extended — additive
   enum values can't be used in the same transaction and buy nothing here).
6. **Post-move sweep fix:** `outstanding` must become
   `agreed − (deposit paid + commitment paid + balance paid?0)` or a paid-commitment
   job reads as overdue forever (current code only knows deposit+balance).
7. **Cancel snapshot must read `card_payments`** (paid/partially_refunded, net of
   `refunded_pence`) — the existing mark-lost unwind only infers from paid flags; that
   gap closes now. Recorded rails attribute method from `deposit_paid_method` /
   `commitment_paid_method` / balance method where known.
8. **Rebook = new appointment + replicate `rescheduleAppointment` side effects**
   (quotes.moving_date, leads.balance_due_date, open balance follow-up due_at,
   `appointment_assignments.reminded_at` reset) — never a bare insert. Appointments
   are status-flipped to `'cancelled'`, never deleted (FK RESTRICT on completions).
9. **Money-state changes write BOTH `activities` (closed enum — use note/status_change)
   and `events_log`** (mirror `refundCardPayment`). Every side effect fail-soft +
   `sendOpsAlert` (money/system category); never abort an unwind on a secondary failure.
10. **/refunds page:** admin-gated server-side via `getSessionProfile()` (the
    /finance/statements pattern — estimator → /estimator/pay, crew → /my-jobs);
    nav entry in the Finance group (nav is NOT the security boundary). Pure engine
    (`lib/refunds/…`) + IO shell, mirroring `lib/payments/received.ts`. Card refunds
    reuse `refundBoundsError` + `refundCardPayment` + the `RefundDialog`
    typed-amount-confirm pattern verbatim (admin-only action). Bank-rail refunds are
    executed in Monzo's UI (the Monzo export carries NO account numbers — verified),
    the row shows the original payment reference; only CASH rows collect recipient
    name/sort/account before "Mark refunded".
11. **Emails:** always via `dispatchComm` (content-hash dedupe + communications audit
    + operational-issue reporting for free); template-env pattern with in-repo
    fallback builders; `accountsFrom()` for money mail; Reply-To `replyAddressFor(token)`
    where a quote token exists. New templates registered in
    `scripts/create-resend-templates.mjs` (idempotent PATCH-by-name).
12. **No Zoho credit-note API exists** — consistent with the deferred list (retained
    rows post no credit note; refunds recorded via events_log + Zoho handled manually).
