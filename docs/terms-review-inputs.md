# T&Cs review — what the ops system needs the terms to cover

Input for the Peter + Connor (+ solicitor) review of the customer terms. The document
customers actually agree to is the website page https://marleymoves.co.uk/terms-conditions/
(`TERMS_URL` in `lib/signatures.ts`) — that page is what the review should update.
Every signature stamps `terms_version` (currently `generic-v1-2026-07-10`); when the
reviewed terms publish, we bump `TERMS_VERSION` and all new signatures record v2.
Nothing already signed is disturbed.

## 1. Clauses the system already relies on — terms MUST back these verbatim

Customers tick these before signing. The terms need a clause behind each tick-box,
and the tick-box wording must stay consistent with the clause.

**Contract acknowledgments (shown on /q and on the crew tablet):**
1. "The move details and inventory in my quote are complete and correct."
   → clause: the fixed price is based on the declared inventory/details; material
   omissions entitle Marley to revise the price or decline items on the day.
2. "I understand items in boxes I pack myself are not covered for breakage."
   → clause: owner-packed goods excluded from breakage cover (standard GIT exclusion).
3. "My belongings include no hazardous items (fuel, gas bottles, paint, chemicals)."
   → clause: prohibited items list; Marley may refuse carriage; customer liable for
   consequences of undeclared hazardous goods.

**Storage-agreement acknowledgments (signed once per let, in person or via /s link).
Two products since the 22 Jul 2026 standing policy (docs/storage-billing-v2-prd.md +
docs/policy-confirmation-for-terms.md §B) — the ack set follows the product:**

*Container lets:*
1. "I agree to the storage rate shown, billed in advance each period until I end the storage."
   → clause: £348 inc VAT per calendar month, billed in advance; **the final month
   bills in full — no pro-rata refund on release** (the billing engine works this
   way by design). No handling fees on containers.

*Crate lets:*
1. "I agree to the crate storage terms: 28-day minimum, then charged to the day;
   handling £72 inc VAT per crate in and out; all charges settled before release."
   → clause: £84 inc VAT 28-day minimum invoiced upfront (2 days' use still pays it);
   day 29+ charged to the exact day in arrears on a 4-weekly cycle at £3/day;
   handling £72 inc VAT per crate per event (in, out, access); the final invoice
   settles before goods are released. (The figures render live from the ops rate
   card — a rate change must update this clause in the same breath.)

*Both products:*
2. "I understand that if invoices stay unpaid for 60+ days, Marley Moves may, after
   written notice, dispose of or sell stored items to recover the charges."
   → the **lien clause** — policy: 60 days → written notice → **statutory 3-month
   minimum** → sale with any surplus returned (≈5-month timeline). Solicitor to
   confirm the notice procedure (how served, how long) so it's enforceable.
3. "Nothing stored is hazardous, perishable, illegal, or irreplaceable without my own insurance."
   → clause: prohibited stored items + customer's own insurance for irreplaceables.

*Further storage clauses the terms need (all enforced or assumed by the system):*
- Release/access **by appointment, subject to availability — no notice promise**;
  access to stored goods only ever through Marley Moves.
- **Price changes on 30 days' written notice, free exit before effect.**
- Storage is payable by bank transfer or cash only; no storage deposit is taken.
- Redelivery/collection transport is quoted separately as a removals job.

**E-signature validity:** signatures are typed-name or finger-drawn (UK eIDAS simple
e-signature). Add a clause: "typing your name or signing on screen constitutes your
agreement, with the same effect as a handwritten signature"; we retain the evidence
pack (name, method, IP, device, timestamp, terms version).

## 2. Money terms the flows enforce — terms must state the same rules

**DECIDED 21 Jul 2026 (Peter + Connor) — the deposit-commitment ladder. The system
now implements exactly this (docs/payments-policy-v2-prd.md); the terms must state it.**

- **Deposit**: £100 secures the booking (card, bank transfer, or cash). **Fully
  refundable, unconditionally, until the customer confirms their move date.**
- **Date confirmation** (a signed step — tick + name, online or in person): from this
  moment the deposit is **non-refundable**, and a second invoice is raised for **25%
  of the gross price minus the deposit**, due **7 days before the move** (due
  immediately if confirmed later than that).
- **Balance**: gross − 25%, bank transfer or cash, **due in full before move day**
  (card is deposit-only by policy). 
- **Cancellation after confirmation — the fill rule**: money held is capped at 25% of
  gross. If Marley **re-books the reserved day, everything is refunded in full**; if
  the day stays unfilled, up to 25% is retained and anything paid above 25% is
  refunded regardless. Refunds go back by the original payment method within **14
  days** of the outcome being known. The clause must tie retention to the **unfilled
  date** (loss-based), never frame it as a penalty — that framing is what makes it
  defensible, and the word "penalty" appears nowhere in system copy by hard rule.
- **Date changes**: free when made more than 7 days before the move (everything
  rolls). Within 7 days, the change is treated as cancelling the old date (fill rule
  applies to it) and booking a new one — money already held counts toward the new
  booking, and only stops counting if the old day dies unfilled.
- **Marley-initiated cancellation or reschedule**: full refund of everything, no
  conditions.
- **The date-confirmation acknowledgment** customers sign (wording provisional until
  the solicitor signs off — the clause and this string must always change together):
  > "I'm confirming this move date. I understand my deposit is now non-refundable and
  > still counts towards my final bill. If I later cancel or move this date within 7
  > days of the move and Marley Moves cannot re-book the day, amounts I've paid up to
  > 25% of my job price may be retained — and are refunded in full if the day is
  > re-booked."
- **VAT**: prices are inclusive of VAT at 20% (VAT no. 520 2213 58 prints on invoices).
  Retained (forfeited) sums keep their VAT treatment — no credit note is issued
  (HMRC forfeited-deposit position, 2022; FRS counts them as turnover).
- **Revised quotes**: a newly accepted quote supersedes earlier ones for the same move;
  money already paid carries over (never charged twice).
- **Late/non-payment after the move**: the system raises an overdue alarm — terms
  should state interest/recovery costs position (or at minimum "payment due before
  completion of the move").

## 3. Service-scope clauses the workflows assume

- **Provisional dates**: quotes can carry an *estimated* move date; the customer may
  amend a provisional booking until the date is fixed (the chase emails promise this).
- **Customer responsibilities**: arrange parking/access and permits; be present or
  represented at collection and delivery; declare items of unusual value; disconnect
  appliances unless quoted otherwise.
- **Insurance limits**: Public Liability £2.5m, Goods in Transit **£50k per load** —
  terms should state the per-load limit, the owner-packed exclusion (ack 2), and
  whether stored goods are covered (confirm with the insurer — checklist F).
- **Waiting time / delays** caused by third parties (keys, chains): state the position
  (included, or chargeable at £X/hr) — currently unstated anywhere.
- **Force majeure, weather, goods left behind, right to subcontract (if ever), complaints
  procedure, governing law England & Wales** — standard boilerplate the current generic
  page should be checked for.

## 4. Completion, damage & claims

- Completion sign-off happens on the crew device (customer + crew lead); **exceptions
  noted at sign-off** are recorded and feed the claims register.
- If the customer is absent at completion, we send a **"check your items" email** and
  the terms currently give a **7-day notification window** for damage claims — the
  solicitor should confirm 7 days is reasonable AND it must not be shorter than the
  insurer's own notification deadline (policy docs are checklist item A7; /claims
  will show the real insurer deadline once we have them).
- How to notify: in writing to hello@marleymoves.co.uk with photos.

## 5. Data & communications (terms should reference; detail lives in the privacy policy)

- **Service communications consent**: quotes, follow-ups/reminders (email + SMS),
  payment receipts, and a post-move review request are part of performing the
  contract — state this so the chase engine is uncontroversial.
- **AI video survey**: an estimator-assisted video of the home interior may be
  processed by an AI provider (Google Gemini) to build the inventory; footage is
  deleted **30 days after the job concludes** (90 days if abandoned). Consent is
  collected at capture; a manual survey is always available. The website privacy
  policy needs its line for this (already queued with the DPIA).
- **Crew job photos/videos**: taken as condition/evidence records during the move.
  **If any job media is ever used for marketing, that needs a separate explicit
  consent** — the job-content publishing phase is planned, so add a marketing-use
  consent line now rather than re-papering later.
- **Privacy policy subprocessor list** (for the website policy, not the T&Cs):
  Supabase/OVH (EU hosting), Cloudflare R2 (EU file storage), Resend (email),
  Webex (SMS), Zoho (invoicing), Google (Gemini AI, Maps), takepayments/Cardstream
  (card payments). Plus the ICO registration number (checklist F).

## 6. Out of scope for THIS review (separate documents)

- **Contractor agreement** (crew-facing) — separate accountant/employment review;
  a reviewed v2 bumps `CONTRACTOR_AGREEMENT_VERSION` and re-prompts every contractor.
- **Website promotional offers** (free boxes cap etc.) — already clause 11 of the
  website terms; just confirm it survives the rewrite.

## After the review — mechanical steps (us)

1. Publish the reviewed terms on marleymoves.co.uk/terms-conditions/.
2. Bump `TERMS_VERSION` in `marley-ops/lib/signatures.ts` (e.g. `reviewed-v2-<date>`).
3. If any tick-box wording changes, update `CONTRACT_ACKS` / `STORAGE_ACKS` in the
   same file so box and clause never drift.
4. Close ClickUp 869e35z42.
