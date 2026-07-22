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

## B. Storage — what the system enforces today

Each storage let has a **signed storage agreement** (in person, or remotely via a
signing link) with three acknowledgments the terms must back verbatim:

1. *"I agree to the storage rate shown, billed in advance each period until I end
   the storage."*
2. *"I understand that if invoices stay unpaid for 60+ days, Marley Moves may,
   after written notice, dispose of or sell stored items to recover the charges."*
   (the lien clause)
3. *"Nothing stored is hazardous, perishable, illegal, or irreplaceable without my
   own insurance."*

**Billing rules (built into the engine — terms must match):**
- Invoiced **in advance**, weekly or monthly, one invoice per period, by **bank
  transfer or cash only** (no card for storage).
- **No storage deposit** is taken.
- **Ending storage: the final period bills in full — no pro-rata refund** for
  leaving mid-period. Billing stops immediately once the let ends; no further
  invoices.
- No notice period is required to end storage (see open question 1 below).

**Non-payment:** overdue invoices are tracked; after **60+ days unpaid and written
notice**, Marley may sell or dispose of stored items to recover charges (the lien).

---

## C. Open points needing a decision (storage clarification)

These are NOT yet decided — the terms agent should leave slots or flag them; the
system will follow whatever is decided:

1. **Notice to end storage.** The system lets a customer end anytime (final period
   bills in full, no pro-rata). Confirm the terms say exactly that — or, if a
   notice period is wanted, decide it and the system needs a small change.
2. **Lien procedure.** Solicitor to specify how written notice is served and how
   long before sale/disposal, so the 60-day lien is actually enforceable.
3. **Insurance of stored goods.** Goods-in-Transit is £50k per load *in transit*;
   whether stored goods are covered must be confirmed with the insurer. Terms
   currently push irreplaceable items to the customer's own insurance (ack 3).
4. **Rate changes on an ongoing let.** Ops can edit the rate, but no notice period
   is defined anywhere. Suggest the terms state e.g. "rates may change with 30
   days' written notice".
5. **Access to stored goods.** Nothing stated — suggest "access by appointment".

## D. Open points on the removals side (already flagged, restated for completeness)

- The date-confirmation acknowledgment wording is provisional until the solicitor
  signs off; clause and string change together (then `TERMS_VERSION` bumps).
- Late/non-payment after the move: terms should state the interest/recovery-costs
  position (system raises overdue alarms only).
- Waiting time / third-party delays (keys, chains): currently unstated — decide
  included vs chargeable.
