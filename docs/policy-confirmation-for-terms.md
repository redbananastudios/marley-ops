# Policy confirmation for the T&Cs draft — what the system actually enforces

Confirmed against the live marley-ops implementation (Payments Policy v2, shipped
21–22 Jul 2026; storage billing phase 2, shipped 10 Jul 2026). The terms must state
exactly these rules — the code enforces them, so any drift between terms and system
is a defect. Companion detail: `docs/terms-review-inputs.md` (clause-by-clause) and
`docs/payments-policy-v2-prd.md` (the locked policy).

---

## A. Removals — deposit, cancellation & refund ladder

Worked example used throughout: £2,400 job (VAT-inclusive), £100 deposit.

1. **Deposit — £100** secures the booking (card, bank transfer, or cash).
   **Fully refundable, unconditionally, until the customer confirms their move date.**
2. **Date confirmation** is a signed step (tick + signature on the online quote page,
   or collected in person / by link). From that moment the deposit is
   **non-refundable** (it still counts toward the final bill).
3. Confirmation raises a second invoice: **25% of the gross price minus the deposit**
   (£500 in the example), due **7 days before the move** — due immediately if
   confirmation happens later than that. Payable by bank transfer or cash.
4. **Balance** (gross − 25%) is due **in full before move day**. Card is
   deposit-only by policy; commitment and balance are bank transfer or cash.

**Cancellation by the customer:**
- *Before* date confirmation → **full refund, always.**
- *After* date confirmation → money held is **capped at 25% of gross**, and one
  question decides the outcome: **did the reserved day re-book?**
  - Day re-booked → **everything refunded in full.**
  - Day stayed empty → up to 25% retained; **anything paid above 25% is refunded
    regardless.**
- Retention is **loss-based** — tied to the unfilled date. The word **"penalty" must
  never appear** anywhere (terms, emails, UI — test-enforced in the codebase).
  Framing: *"held against your original date — refunded in full if we re-book it."*

**Date changes:**
- **More than 7 days before the move → free.** Everything rolls (dates, invoices,
  money held); the booking stays confirmed. Exactly 7 days out counts as free.
- **Within 7 days → treated as cancelling the old date** (fill rule applies to it)
  **and booking a new one** on the same job. **No second £100 is ever taken** —
  money already held counts toward the new booking, and only stops counting if the
  old day dies unfilled (any shortfall is then adjusted on the final bill).

**Marley cancels or moves the date:** **full refund of everything, immediately,
no conditions.**

**Refund mechanics:** refunds return by the **original payment method** (card → same
card; transfer → originating account; cash → bank transfer to a named account)
within **14 days** of the outcome being known. Card fees are absorbed — never
surcharged, never deducted from refunds.

**VAT:** all customer prices are VAT-inclusive at 20% (VAT no. 520 2213 58 on
invoices). Retained sums keep their VAT treatment — no credit note (HMRC 2022
forfeited-deposit position).

**Revised quotes:** a newly accepted quote supersedes earlier ones for the same
move; money already paid carries over — the customer is never charged twice.

**The signed date-confirmation acknowledgment** (wording provisional until solicitor
sign-off; this string and the terms clause must always change together):

> "I'm confirming this move date. I understand my deposit is now non-refundable and
> still counts towards my final bill. If I later cancel or move this date within 7
> days of the move and Marley Moves cannot re-book the day, amounts I've paid up to
> 25% of my job price may be retained — and are refunded in full if the day is
> re-booked."

---

## B. Storage — the standing policy (Peter, 22 Jul 2026) — the system enforces this

Two storage products with different billing schedules. All customer-facing
figures **gross (VAT-inclusive)**. Full spec: `docs/storage-billing-v2-prd.md`.

**Container — £348 inc VAT per calendar month.**
- Billed monthly **in advance**; first month invoiced at commencement.
- End any time; **the final month bills in full — no pro-rata refund**. Billing
  stops immediately once storage ends.
- One customer per container. **No handling fees.**

**Crate — £21 inc VAT per week ⇒ £3 per day.**
- **28-day minimum (£84 inc VAT), invoiced upfront** at commencement — 2 days'
  use still pays £84.
- **Day 29 onward is charged to the exact day, in arrears, on a 4-weekly cycle.**
- **Handling: £72 inc VAT per crate per event** — in, out, and any access.
- **Release: the final invoice (unbilled days to the release day + handling out)
  is settled before goods leave.** Charges accrue until goods physically leave.
- Redelivery/collection transport is quoted as a normal removals job.

**Both products:**
- Bank transfer or cash only (no card for storage). No storage deposit.
- **Release/access by appointment, subject to availability — no notice promise.
  Access to stored goods only ever through Marley Moves.**
- **Price changes: 30 days' written notice, with free exit before the change
  takes effect.**
- **Arrears:** 60+ days unpaid → written notice → **statutory 3-month minimum
  period** → sale/disposal to recover charges, **any surplus returned** (≈5-month
  end-to-end timeline).

**Signed acknowledgments (terms must back these verbatim):**
- Container (unchanged): *"I agree to the storage rate shown, billed in advance
  each period until I end the storage."*
- Crate (new): *"I agree to the crate storage terms: 28-day minimum, then charged
  to the day; handling £72 inc VAT per crate in and out; all charges settled
  before release."* (The £72 and 28 render live from the ops rate card — a rate
  change must update the terms clause in the same breath.)
- Both: the lien ack (*"…if invoices stay unpaid for 60+ days… after written
  notice, dispose of or sell stored items to recover the charges"*) and the
  prohibited-items ack (*"Nothing stored is hazardous, perishable, illegal, or
  irreplaceable without my own insurance."*)

---

## C. Storage points still needing the solicitor / insurer

1. **Lien procedure.** The policy is 60 days → written notice → statutory
   3-month minimum → sale with surplus returned. Solicitor to confirm the notice
   mechanics (how served, to which address) so it's enforceable, and that the
   ack wording above matches the clause.
2. **Insurance of stored goods.** Goods-in-Transit is £50k per load *in transit*;
   whether stored goods are covered must be confirmed with the insurer. Terms
   currently push irreplaceable items to the customer's own insurance.

## D. Open points on the removals side (already flagged, restated for completeness)

- The date-confirmation acknowledgment wording is provisional until the solicitor
  signs off; clause and string change together (then `TERMS_VERSION` bumps).
- Late/non-payment after the move: terms should state the interest/recovery-costs
  position (system raises overdue alarms only).
- Waiting time / third-party delays (keys, chains): currently unstated — decide
  included vs chargeable.
