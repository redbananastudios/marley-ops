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

**Storage-agreement acknowledgments (signed once per let, in person or via /s link):**
1. "I agree to the storage rate shown, billed in advance each period until I end the storage."
   → clause: billing in advance weekly/monthly; **the final period bills in full — no
   pro-rata refund on release** (the billing engine works this way by design).
2. "I understand that if invoices stay unpaid for 60+ days, Marley Moves may, after
   written notice, dispose of or sell stored items to recover the charges."
   → the **lien clause** — this is the one with real teeth; solicitor should confirm
   the notice procedure (how served, how long) so it's enforceable.
3. "Nothing stored is hazardous, perishable, illegal, or irreplaceable without my own insurance."
   → clause: prohibited stored items + customer's own insurance for irreplaceables.

**E-signature validity:** signatures are typed-name or finger-drawn (UK eIDAS simple
e-signature). Add a clause: "typing your name or signing on screen constitutes your
agreement, with the same effect as a handwritten signature"; we retain the evidence
pack (name, method, IP, device, timestamp, terms version).

## 2. Money terms the flows enforce — terms must state the same rules

- **Deposit**: £100 secures the booking. Acceptance is **provisional until the deposit
  is received**; the date is only confirmed on payment. Payable by card or bank transfer.
- **Balance**: bank transfer or cash, **due in full before the move day** (card is
  deposit-only by policy). Final invoice = agreed price − deposit.
- **VAT**: prices are inclusive of VAT at 20% (VAT no. 520 2213 58 prints on invoices).
- **Revised quotes**: a newly accepted quote supersedes earlier ones for the same move;
  a deposit already paid carries over (never charged twice).
- **Cancellation & refunds — NEEDS A DECISION**: the system has a refund/void flow but
  no policy behind it. Decide the schedule with Connor, e.g. deposit refundable if
  cancelled ≥N days before the move, retained inside N days; Marley-initiated
  cancellation = full refund. Whatever is chosen, the /q payment page copy and the
  chase emails should echo it.
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
