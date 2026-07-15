# PRD — Card payments via takepayments (deposit pay-by-link)

Status: DRAFT for Peter's review · 2026-07-15
Owner: Peter · Builder: Claude/codex · Repo: marley-ops

## 1. Summary

Customers accepting a quote on `/q/<token>` can pay the £100 deposit **by card** on
takepayments' Hosted Payment Page (HPP), alongside the existing bank-transfer panel. The
office gets instant paid-status (same machinery as today: confirmed status, Zoho payment
record, deposit-received email, `payment_event` push, chase closed) plus a one-click,
admin-gated **card refund**. takepayments replaces the previous plan of a Zoho-connected
gateway (Stripe) — the `/q` card button stops linking to the Zoho invoice URL and instead
posts to the HPP under our control.

**Protocol recap** (full notes: `O:\RBS-OS\references\takepayments-api.md`): takepayments
online = white-labelled Cardstream gateway. Signed `x-www-form-urlencoded` POSTs, SHA-512
signature. Hosted Payment Page handles the card form + 3DSv2 → we stay SAQ-A. Server-to-server
result via `callbackURL`; refunds via Direct `REFUND_SALE` with the stored `xref`.

## 2. Hard constraints (Peter, 2026-07-15)

- **One-off payments only.** Every transaction is `action=SALE`, `type=1` (ECOM), single
  authorisation. **NO recurring agreements, NO Credentials-on-File, NO `rtAgreementType`,
  ever.** Storage billing stays BACS via Zoho — out of scope here.
- **We never store card details.** No PAN, no CVV, no expiry touches our servers (HPP-only
  collection). We persist only what the gateway returns for bookkeeping: `xref`,
  `cardNumberMask` (e.g. `492942******0821`), `cardScheme`, `authorisationCode`. That is
  reference data, not reusable payment credentials.
- **Deposit is the only card payment** (existing card policy — balance stays BACS/cash for
  fees). The design leaves a seam for balance-by-card later but ships deposit-only.
- Gateway customer receipts stay **off** — our branded deposit-received email is the receipt.

## 3. What exists today (build on, don't duplicate)

| Surface | Today | Change |
| --- | --- | --- |
| `/q/<token>` payment view | `cardOk = zoho_deposit_invoice_url && isPaymentGatewayActive()` → button links to Zoho's payment page | Button becomes our HPP hand-off; `cardOk` becomes takepayments-config-driven |
| `lib/quote/accept-flow.ts` → `markDepositPaid()` | Idempotent paid-flip: confirmed status, Zoho payment record, branded email, chase close, `payment_event` push | Called by the new callback with `method: "card"` — **no changes to the paid path** |
| `/api/cron/zoho-deposits` (15-min) | Detects payments recorded in Zoho | Stays (BACS/manual Zoho entries). New sibling cron reconciles takepayments attempts |
| Bookings page / lead payments card | Awaiting-deposit → one-tap BACS paid | Gains card-status chip + refund entry point |
| `business_settings` kill switches | push pattern (global + per-category) | Same pattern: `card_payments_enabled` |
| `proxy.ts` matcher exclusions | `sw.js`, fonts, `/api/version` | Add the two public card routes |

## 4. Architecture

```
Customer                     marley-ops (Vercel)                    takepayments
--------                     -------------------                    ------------
/q → [Pay £100 by card]
        └─ POST startCardPayment ─→ mint card_payments row (pending)
                                    build signed SALE fields
        ←─ auto-submit <form> ──────┘
        └─────────── browser POST ────────────────────────────────→ HPP (card + 3DS)
                                                                        │
        ←──────────── browser POST redirectURL ─────────────────────────┤
             /api/card/return  → verify sig → 303 /q/<token>            │
                                    /api/card/callback ←── server POST ─┘
                                    verify sig + amount + claim row
                                    responseCode 0 → markDepositPaid("card")
                                    store xref/mask/authCode

Reconcile cron (15-min): pending rows older than 10 min → Direct QUERY by
transactionUnique/xref → settle the row the same way (callback belt-and-braces).

Refund: admin action → Direct REFUND_SALE (xref, amount) → update row → timeline.
```

New modules:

- `lib/payments/takepayments.ts` — pure protocol module: `sign()`, `verifySignature()`,
  `buildHostedSaleFields()`, `directRequest()` (QUERY / REFUND_SALE / CANCEL). The signing
  algorithm is **transcribed from the official Node SDK's `gateway.js`** (PHP-compatible key
  sort, `%2A`, CR/LF→`%0A` quirks) with golden tests pinned to that implementation — the same
  verbatim-port discipline as the pricing engine. No npm dependency (their SDK is unpublished
  and ancient; the port is ~150 lines).
- `lib/payments/card-payments.ts` — attempt lifecycle (mint, claim, settle, refund) — pure,
  tested.
- `app/api/card/return/route.ts` + `app/api/card/callback/route.ts` — public, signature-gated.
- `app/api/cron/card-reconcile/route.ts` — QUERY poll for stragglers.

## 5. Data model — migration 0043

```sql
create table card_payments (
  id uuid primary key default gen_random_uuid(),      -- doubles as transactionUnique
  quote_id uuid not null references quotes(id),
  lead_id uuid references leads(id),
  client_id uuid references clients(id),
  kind text not null default 'deposit',               -- seam for 'balance' later
  amount_pence integer not null,
  status text not null default 'pending',
  -- pending → paid | failed | abandoned; paid → refunded | partially_refunded | voided
  gateway_xref text,                                  -- for REFUND_SALE / QUERY
  gateway_transaction_id text,
  response_code integer,
  response_message text,
  card_number_mask text,                              -- as returned; never PAN
  card_scheme text,
  authorisation_code text,
  refunded_pence integer not null default 0,
  refund_reason text,
  refunded_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  refunded_at timestamptz
);
-- service-role only (RLS enabled, no policies) — same posture as push_subscriptions.
-- Partial unique: one live pending attempt per quote (retries first mark old row failed).

alter table business_settings add column card_payments_enabled boolean not null default false;
```

`quotes` unchanged — `deposit_paid_at` / `deposit_paid_method='card'` stay the source of
truth for "paid"; `card_payments` is the gateway ledger hanging off it.

Env (in `/opt/marley-ops/app.env` + `.env.local`, never NEXT_PUBLIC):
`TAKEPAYMENTS_MERCHANT_ID`, `TAKEPAYMENTS_SIGNATURE_KEY`, `TAKEPAYMENTS_HOSTED_URL`,
`TAKEPAYMENTS_DIRECT_URL` (account-specific URLs from onboarding), `TAKEPAYMENTS_TEST_MODE`.

## 6. UX spec

Three people touch this: the **customer** (on a phone, from an email), the **office**
(Connor/Bex on the panel), and the **admin** (Peter). Principle throughout: card is the
fast path, BACS is never hidden, and nobody ever sees a gateway error verbatim.

### 6.1 Customer — `/q/<token>` (mobile-first; this is the "payment link")

The quote email CTA, PDF QR and SMS all already point at `/q`. Nothing about how customers
receive the link changes — the payment view just gets a real card button.

**State A — accepted, unpaid (the payment view):**

```
┌────────────────────────────────────────────┐
│ QUOTE ACCEPTED — ONE LAST STEP   (charcoal)│
├────────────────────────────────────────────┤
│ Your date is reserved. It locks in as      │
│ soon as the £100 deposit arrives.          │
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │      Pay £100 deposit by card  →       │ │  ← mm-red h-14 primary (existing style)
│ └────────────────────────────────────────┘ │
│    Secure payment · Visa / Mastercard /    │
│    Apple Pay / Google Pay                  │  ← 12px mist, wallet line only if enabled
│                                            │
│ ──────────────  or  ──────────────         │
│ ┌ Pay by bank transfer ─────────────────┐  │
│ │ (existing BANK_DETAILS panel,         │  │
│ │  unchanged, incl. quote-ref)          │  │
│ └───────────────────────────────────────┘  │
│ [ I've sent the bank transfer ] (existing) │
└────────────────────────────────────────────┘
```

- Tapping the button shows an inline spinner ("Taking you to secure payment…"), the server
  mints the attempt, and the browser auto-submits the signed form — full-page navigation to
  the HPP (no iframe/lightbox: full-page is the reliable path from email links on iOS/Android
  and keeps the gateway's own 3DS UX intact).
- **HPP is branded** — logo + charcoal/mm-red requested from takepayments at onboarding, so
  the hand-off doesn't feel like leaving Marley.
- Button renders only when `cardOk` = env creds present AND `card_payments_enabled` AND
  deposit unpaid. Kill switch off → the page is simply BACS-only, exactly as today.

**State B — returning from the HPP:**
`/api/card/return` verifies the signed browser POST then 303s to `/q/<token>?card=ok|failed`.
The page renders **from the DB**, not the query param (the param only picks a toast):

- Success → the existing green "Deposit received — you're booked" card (unchanged), toast
  "Payment confirmed". If the callback hasn't landed yet (rare race), the return handler
  itself settles the row — the customer never sees a "pending" screen.
- Failure/decline → payment view again with an amber banner:
  *"Your card payment didn't complete — **no money has been taken**. You can try again, or
  pay by bank transfer below."* Retry mints a fresh attempt. No gateway jargon, no response
  codes.
- Abandoned (closed the HPP tab) → nothing changes; `/q` still shows the payment view; the
  attempt row is swept to `abandoned` by the reconcile cron.

**Already-paid guard:** if the deposit got marked paid (e.g. office BACS tap) while a card
attempt was mid-flight and the card THEN succeeds, the callback sees `already=true` **with
real money taken** → auto-raises the existing refund-decision task + ops alert, customer sees
the paid state. Never silent, never double-booked revenue.

### 6.2 Office — Bookings page + lead payments card

- **Bookings › Awaiting deposit** rows gain a small neutral chip when a card attempt exists:
  `Card attempted · failed` / `Card · paid 14:02` (paid rows already move to "To book").
  No new columns, no new page — the chip answers "did they try to pay?" at a glance, which
  is the first question on a chase call.
- **Lead page › Payments card** (existing) lists the card ledger: masked card, amount,
  status pill, time. Paid row shows **Refund** (admin-gated — see 6.3). Every event also
  writes the lead timeline ("£100 deposit paid by card •••• 0821", "Deposit refunded £100 —
  reason: …") so Comms/Overview tell the story without opening Zoho.
- The office takes **no new action** for a normal card payment — banner + push + confirmed
  status all fire from the existing paid path. Their workflow is unchanged; things just
  arrive pre-paid.

### 6.3 Admin — refunds + settings

**Refund dialog** (from the lead payments card; `admin` role only, office sees the ledger
but no refund button):

```
Refund card deposit — MMR014
Amount    [£ 100.00]   (max £100.00 — partial allowed)
Reason    [ required, free text                    ]
⚠ Goes back to the customer's original card (•••• 0821),
  typically within 3–5 working days. This can't be undone.
[Cancel]                       [Refund £100.00]  (danger-red)
```

- Confirm → `REFUND_SALE` → row → `refunded`/`partially_refunded`, timeline + `events_log`
  entry (actor, amount, reason). Failure surfaces the gateway message in the dialog and
  leaves state untouched (retryable).
- Same-day voids: if the transaction hasn't settled (< ~midnight), we attempt `CANCEL`
  first and fall back to `REFUND_SALE` — saves the transaction fee; invisible to the user.
- Wire-in: the cancellation-unwind's existing "refund decision" task deep-links to this
  dialog.
- Zoho: refund recorded as a note/credit on the -DEP invoice via the existing pattern
  (manual-fallback ops alert if the write fails, mirroring `markDepositPaid`).

**Settings › Payments** (new small section, mirrors the push panel):

- Master toggle "Card payments on `/q`" (`card_payments_enabled`).
- Status line: merchant ID (masked), mode (TEST/LIVE), last successful callback age.
- Admin **"Run £1 test payment"** button in TEST mode only — mints a real simulator attempt
  and opens the HPP, proving the loop end-to-end (the push panel's test-button pattern).
- Integration health page gains a `takepayments` row: config present + pending-attempts
  backlog age (no live gateway ping needed).

### 6.4 Copy touch-points (small, ship with the feature)

- Quote email + deposit-request email: "pay securely by card or bank transfer" (the `/q`
  page already says this on the accept step — the sentence stays true once the button is real).
- Deposit chase emails: CTA copy gains "takes two minutes by card".
- `/manual` payments section + office tour: one line each on the card path + refunds.

## 7. Server flows (precise)

**Start (`startCardPaymentAction`, public but token-gated like the other /q actions):**
resolve quote by token → guards (accepted, deposit unpaid, cardOk) → mark any previous
pending attempt `failed` → insert `card_payments` row (id = `transactionUnique`) → build
signed fields: `merchantID, action=SALE, type=1, amount=<pence>, currencyCode=826,
countryCode=826, transactionUnique=<row id>, orderRef="<quote_ref> deposit",
customerName/Email (prefill only), redirectURL=/api/card/return,
callbackURL=/api/card/callback, signature` → return fields; client renders hidden form and
submits to `TAKEPAYMENTS_HOSTED_URL`.

**Callback (`/api/card/callback`, public):** parse form body → `verifySignature()` (reject
403 on mismatch) → load row by `transactionUnique` (404-shape unknowns) → **verify
`amountReceived` == row amount and currency 826** → atomic claim
(`update … set status where status='pending'` — first writer wins; return/callback/cron all
race safely) → `responseCode 0`: store xref/mask/authCode, `settled_at`, call
`markDepositPaid(sb, quote_id, { method: "card", actorId: null, recordInZoho: true })`;
non-zero: store code+message, status `failed`. Always 200 to the gateway. Full raw response
never logged (log = row id + code only).

**Return (`/api/card/return`, public):** same verify + settle logic (idempotent — usually
the callback won by the time the browser lands), then 303 to `/q/<token>?card=…`. Both
routes added to the `proxy.ts` matcher exclusions (auth 307 would eat the gateway POST —
same class as the sw.js/fonts bug).

**Reconcile cron (`/api/cron/card-reconcile`, 15-min, CRON_SECRET):** rows `pending` older
than 10 min → Direct `QUERY` → settle as above; older than 24 h with no gateway record →
`abandoned`. Covers a missed callback (no documented gateway retry) and abandoned HPP tabs.

**Refund (`refundCardPaymentAction`, admin-gated):** guards (row paid, amount ≤ remaining)
→ try `CANCEL` when unsettled same-day, else `REFUND_SALE(xref, amount)` → verify signed
response `responseCode 0` → update row, timeline, `events_log`, Zoho note. Idempotency: the
action re-reads the row state first and the gateway itself rejects over-refunds by xref.

## 8. Security & compliance checklist

- [ ] HPP-only card collection — no PAN/CVV field ever rendered or received by us (SAQ-A).
- [ ] Persisted card data limited to gateway-returned mask/scheme/authCode/xref — **no
      reusable credentials, satisfying "we don't store details"**.
- [ ] One-off `SALE` only; CoF/recurring fields never sent (test asserts the built field set).
- [ ] Signature verified on EVERY inbound message (return + callback); amount + currency
      cross-checked against our row — customer-side tampering impossible (amount is signed
      by us, verified by gateway; result signed by gateway, verified by us).
- [ ] `transactionUnique` = UUID row id → replayed callbacks are no-ops (atomic claim).
- [ ] Secrets server-side only; signature key never in client bundle; logs redacted.
- [ ] Refunds admin-role-gated + reason + audit trail; rate-limited (5/hr) like passkey fails.
- [ ] Public routes 404-shape on unknown tokens/ids (matches /q posture); no enumeration.

## 9. Testing

- **Golden signature tests** — `tests/lib/payments/takepayments.test.ts`: fixtures generated
  with the official SDK's `sign()` (incl. the nasty cases: `*`, CRLF in orderRef, nested
  fields, partial signing `hash|fields`) — our port must match byte-for-byte. Response
  verification fixtures both valid and tampered.
- **Lifecycle unit tests** — claim races (callback vs return vs cron), amount mismatch,
  already-paid double-take → refund task, refund/void state machine, kill-switch gating.
- **Simulator E2E** (test merchant ID) — ⚠ **amount gotcha:** the simulator maps amount
  ranges to outcomes and **10000p (£100.00) is the DECLINE range**. TEST_MODE therefore
  allows an admin-only amount override; E2E uses £24.99 (success), £100 (decline path),
  expiry month 12 (3DS challenge), then `REFUND_SALE` + `QUERY` against the paid txn.
  Run on a seeded lead (Freddy pattern), then test state cleaned.
- House gates before every push: `npm run lint`, `npx tsc --noEmit`, `npm test`, build.

## 10. Rollout

1. Build + tests now against the shared/test merchant account (SDK ships test creds —
   verify they work; otherwise wait for the onboarding test MID).
2. Onboarding pack arrives → env into `/opt/marley-ops/app.env` + `.env.local` + Vercel;
   request at onboarding: **branded HPP (logo/colours), Apple Pay + Google Pay enabled,
   gateway customer receipts OFF, account-specific URLs, MMS login for Connor**.
3. Deploy with `card_payments_enabled=false` → Settings test button proves the loop in TEST.
4. Swap to production MID → one real £1-style live test (then refund it via the panel —
   which also proves refunds in prod) → flip the toggle → card button live on `/q`.
5. Update memory + CLAUDE.md; remove "Stripe" from rollout blockers.

## 11. Open questions for Peter

1. **Refund email** — when we refund a deposit, send the customer a branded "we've refunded
   £X" email automatically, or leave it to the office to communicate? (Lean: yes, automatic,
   Comms-logged.)
2. **Failed-payment nudge** — if a card attempt fails and no payment arrives within 24 h,
   should the deposit chase mention "your card payment didn't complete"? (Lean: no v1 —
   existing chases already cover unpaid deposits.)
3. **Office visibility of declines** — chip-only (spec'd) or also a dashboard needs-action
   card for "card declined, no deposit yet"? (Lean: chip-only; Bookings already surfaces
   awaiting-deposit.)
4. Deposit stays fixed £100 — confirmed? (Everything is amount-agnostic regardless.)

## 12. Out of scope (explicit)

Balance by card (seam left via `kind`), recurring/CoF of any sort, storage billing cards,
Direct card capture, surcharges, SOTPay/MMS pay-buttons, multi-currency, Zoho-hosted payment
page (superseded by this).
