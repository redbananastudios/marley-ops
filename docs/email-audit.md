# Marley Ops — Resend email audit (content + design)

Working record of the 1-by-1 email audit with Peter (started 2026-07-13). Confirmed content + the locked house style. Build all 13 from this once content is signed off.

## House style (LOCKED)
- **Design:** Variant 3 "Airy Premium" — white header with the horizontal logo (https://marleymoves.co.uk/logo.png), big light Montserrat 300 headline, generous spacing, **filled red 1-2-3 step circles**, bordered "included as standard" tick panel, red "prefer to talk" call button, hairline centred footer. Body font **Montserrat**.
- Mockup artifact: https://claude.ai/code/artifact/2b19bcc4-e00b-4e51-bf42-19aef443936a

## Standard footer (EVERY email)
```
MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58
Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX
01747 637070 · hello@marleymoves.co.uk · marleymoves.co.uk
Fully insured — Public Liability up to £2.5m · Goods in Transit up to £50k
Registered in England & Wales · Terms · Privacy
```
- **Legal name `MarleyMoves Ltd`** (one word) in footers/legal; brand `Marley Moves` (space) in copy + "The Marley Moves Team" sign-off.
- "Included as standard, all free" story to weave in where it fits: free survey, free boxes, free furniture & wardrobe boxes, full insurance cover.

## Confirmed process facts (Peter, 2026-07-13)
- Enquiry → acknowledgement (auto-reply), NOT a fixed price in the hour.
- Team **always calls** — Luke, Connor or Peter — usually within the hour, always same day; if no answer, leave a message/email. If on hand at enquiry, it's an immediate call.
- **In-person survey is the norm** (remote only for far-away or very small moves).
- **Fixed price is emailed on the spot AT the survey** — accurate but subject to terms and conditions.
- No asking customers to send photos.
- Sign-off: **The Marley Moves Team**.

---

## Email 1/13 — lead-auto-reply — ✅ CONTENT + DESIGN CONFIRMED
Acknowledgement of website enquiry. We've got your enquiry → we call you (usually within the hour, same day; message/email if no answer) → free in-person survey (remote only far/small) → written fixed-price quote. Everything-free line. Signed team. (Not in the marley-ops registry — separate Resend template d6f49493.)

## Email 2/13 — survey-confirmation — ✅ CONTENT CONFIRMED (pending final ok)
Vars: CUSTOMER_FIRST_NAME, DATE_LABEL, TIME_LABEL, ESTIMATOR, ADDRESS.
- Free home survey booked; {ESTIMATOR} (the estimator selected on the survey) comes to take a proper look for an accurate written fixed price.
- Duration: **usually well under an hour** (quicker than the old "about an hour").
- Prepare: **ensure access to every room/area items will be moved from** — loft, garage, outbuildings.
- **Fixed price emailed on the spot at the visit**; we take care to get it right, subject to T&Cs.
- In-person only (this template doesn't fire for remote). Change time → call/reply.

## Email 3/13 — quote-email — ✅ CONTENT CONFIRMED (pending final ok)
The fixed price, emailed on the spot at the survey OR sent directly for small/remote jobs. **One template, both cases** via a new app-set variable `{{{QUOTE_INTRO}}}` (survey → "Thanks for having us round — here's your written fixed price"; direct → "Here's your quote for the move you described").
- Total move cost {GRAND_TOTAL} · valid until {EXPIRY_DATE}. Job at a glance blocks unchanged.
- **What happens next:** 1) Accept online (~30s), date reserved. 2) Pay {DEPOSIT_AMOUNT} deposit (card/bank transfer) — locks booking. 3) **Balance due 24 HOURS BEFORE moving day** (corrected from "on completion"), then we move you.
- **Included free reminder:** survey, boxes, furniture & wardrobe boxes, insurance. Tell us if you want boxes dropped off; estimator flags wardrobe boxes/chair covers etc.
- Call **the team** (not Connor). Price fixed, subject to T&Cs. Standard footer.
- NEW app work: set `QUOTE_INTRO` per survey-vs-direct; deposit stays `{DEPOSIT_AMOUNT}`.

## Note (Peter): a quote may be sent **directly without a survey** for small-item moves or jobs further away — quote-email must serve both (handled via QUOTE_INTRO).

## Emails 4-6/13 — chase-quote-1/2/3 — ✅ CONFIRMED
Personal, friendly-**professional**, signed by the lead owner `{{OWNER_NAME}}` (NOT team, NOT Connor). Vars add OWNER_NAME. £100/`{{DEPOSIT_AMOUNT}}` secures date + crew. Urgency line ("dates fill, month-end/Fridays first") is honest — keep. chase-3 feedback ask reworded to "any feedback on your decision would genuinely help us improve" (was "tell us what swung it"). chase-1 subject → "Your removal quote — any questions, {name}?" (more professional). All get standard footer.

## Email 7/13 — deposit-received — ✅ CONFIRMED
Open "Hi {name}, / Thank you for booking with Marley Moves." We've received your {AMOUNT} deposit for {MOVE_DATE_LABEL} — date + crew secured. BALANCE_LINE (app-set): "remaining balance of £X due 24 hours before your move, unless we've agreed otherwise." Reassurance KEPT but NOT promising a day-before call: "If we need anything beforehand we'll be in touch — otherwise rest assured we'll see you on the day." Tell us if you want boxes. Call **the team**. Footer.

## Emails 8-9/13 — chase-deposit-1/2 — ✅ CONFIRMED
Personal from `{{OWNER_NAME}}` (like quote chases), friendly-professional. `{{DEPOSIT_AMOUNT}}` secures date + crew. chase-1 keeps bank-transfer reference {QUOTE_REF}. chase-2 keeps "I'd genuinely rather help than chase." Footer.

## Email 10/13 — balance-invoice — ✅ CONFIRMED (pending payment-method q)
"Hi {name}, / Your final balance." Due **24 hours before your move (unless agreed otherwise)** (was "before move day"). Deposit deducted. Bank details MARLEYMOVES LTD · 04-00-03 · 12787423 · ref {QUOTE_REF}. Card is deposit-only (fee policy) → balance shows bank transfer [+ cash? Q pending]. Call **the team**. Footer.

## Email 11/13 — balance-received — ✅ CONFIRMED
"Hi {name}, / All settled — thank you." Balance {AMOUNT} received, nothing more to pay, see you on {MOVE_DAY_LABEL}. Call **the team**. Footer.

## Email 12/13 — completion-certificate — ✅ CONFIRMED
"Hi {name}, / That's your move complete." **EXTEND with genuine gratitude** — really appreciate them choosing Marley Moves (not just thankful). Certificate attached. {STATUS_LINE}. Call **the team**. Footer.

## Email 13/13 — review-request — ✅ CONFIRMED
"Hi {name}, / How did we do?" **EXTEND with real gratitude** for choosing Marley Moves. KEEP "if Connor and the crew looked after you". Google review button {REVIEW_URL}. If not right, reply/call **the team** first. Footer.

## Cross-cutting confirmations
- balance-invoice payment methods: **bank transfer, card OR cash** (card NOT deposit-only — accept all three on the balance).
- completion + review: lay the gratitude on genuinely — "we really appreciate you choosing Marley Moves for your move".

---

# BUILD STATUS (2026-07-13)
Source of truth = `scripts/create-resend-templates.mjs` (idempotent PATCH-by-name → keeps Resend IDs). In-repo fallbacks in `lib/comms/*.ts` (keep in sync). Chase copy also in `lib/quote/chase.ts`.

**Done — foundation:** new house-style shell (`shellHtml`): Montserrat (`FONT_LINK` + `FONT_STACK` fallback), white logo header (LOGO_URL → marleymoves.co.uk/logo.png), big light left-aligned headline (`headlineRow`), `greetRow`, `stepsRow` (red circles), `inclRow` (tick panel), `callButton`, and `STANDARD_FOOTER` (MarleyMoves Ltd · Co No 15914266 · VAT 520 2213 58 · full address · insurance · Registered E&W · Terms/Privacy). Script parses.

**Remaining:**
1. Reorder: move shellHtml+helpers ABOVE the standalone templates (survey/completion/review) so they can use them.
2. Rewrite each template's inner with the CONFIRMED copy above (greet + big headline + new copy + call the team; steps; incl-free where it fits; quote 24h-balance; deposit-received "Thank you for booking" + rest-assured line; balance-invoice bank/card/cash + 24h; gratitude on completion/review).
3. Chases: from the **lead owner** — add `OWNER_NAME` var, swap Peter's fixed signature for the owner, apply new professional copy. (chase copy also lives in lib/quote/chase.ts.)
4. App logic: populate `OWNER_NAME` (lead owner) on chase sends; add `QUOTE_INTRO` (survey vs direct) to quote-email; `BALANCE_LINE`/balance-invoice → "due 24h before your move, unless agreed otherwise".
5. Update the `lib/comms/*.ts` in-repo fallbacks to match.
6. **lead-auto-reply** (Resend d6f49493) is NOT in this registry — it's the website's auto-reply; source in the marley SITE repo (`/o/projects/red-banana/clients/marley/site/web`). Update there OR add to this registry.

**BLOCKER — deploy:** `create-resend-templates.mjs` needs a **FULL-ACCESS** Resend key (Marley team). Send-only `MARLEY_RESEND_API_KEY` can't PATCH/publish. Peter to create one → set `RESEND_FULL_API_KEY` (local run) → `node scripts/create-resend-templates.mjs` (PATCHes existing, keeps IDs, republishes). No env re-wire needed (same IDs).
- Render/preview locally with no key: `node scripts/create-resend-templates.mjs --preview-dir <dir>`.
- Or send a one-off test render to Peter's sink via the send-only key to confirm the look.

## Resend template IDs: scratchpad/resend-ids.json
