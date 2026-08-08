# takepayments query — 5 declines with an identical gateway error

Prepared 2026-08-08 from live `card_payments` rows. Merchant 292748 (Cardstream
white-label). All five are real customer deposit attempts, `is_test = false`.

## Why this looks gateway-side, not customer-side

Six of nine card deposit attempts since go-live failed. Five share an identical
signature — **`response_code = 6`, `response_message = "ERROR"`,
`authorisation_code = 000041`** — across **four different cards** (Visa and
MasterCard, different issuers) and **two different days**. A genuine customer
decline does not present as the same auth code on unrelated cards.

The sixth failure is unrelated and looks correct: `response_code = 5`,
`AVS CV2 DECLINED` — a real address/CVV mismatch, and that same card succeeded
six minutes later.

All three attempts since 4 August have succeeded, so it may have cleared or be
intermittent. Worth asking regardless: each of these was a customer trying to
pay a deposit who then had to pay another way, or dropped out.

## The five transactions

| Date/time (UTC) | Amount | Card | Scheme | `transactionUnique` (xref) | Gateway txn id |
|---|---|---|---|---|---|
| 2026-07-31 20:22:04 | £100.00 | 552213\*\*\*\*\*\*4688 | MasterCard | `26073121YR23FR18GB15JJK` | 498447106 |
| 2026-07-31 20:23:34 | £100.00 | 531598\*\*\*\*\*\*7866 | MasterCard | `26073121ZF23PC52HW68DJX` | 498447243 |
| 2026-08-03 09:37:27 | £100.00 | 467062\*\*\*\*\*\*8298 | Visa | `26080310BT38HV30WV32THS` | 499099853 |
| 2026-08-03 12:21:23 | £100.00 | 515469\*\*\*\*\*\*9587 | MasterCard | `26080313RF21CQ39HD05LCJ` | 499154448 |
| 2026-08-03 12:22:08 | £100.00 | 543458\*\*\*\*\*\*3501 | MasterCard | `26080313NB24KY40LF45GJK` | 499155432 |

Every one returned `response_code 6` / `ERROR` / auth code `000041`.

## Draft message

> Hello,
>
> We're on merchant ID 292748, taking £100 deposits through the Hosted Payment
> Page. Between 31 July and 3 August we had five payment attempts fail with what
> looks like the same gateway-side error rather than a card decline:
> response code 6, response message "ERROR", authorisation code 000041.
>
> These were five different customers across four different cards (both Visa and
> MasterCard, different issuers), so we don't think this is an issuer decline.
> The transaction references are:
>
> 26073121YR23FR18GB15JJK (498447106)
> 26073121ZF23PC52HW68DJX (498447243)
> 26080310BT38HV30WV32THS (499099853)
> 26080313RF21CQ39HD05LCJ (499154448)
> 26080313NB24KY40LF45GJK (499155432)
>
> Could you tell us what response code 6 with authorisation code 000041 means on
> our account, and whether anything was misconfigured or degraded during that
> window? Payments since 4 August have gone through normally, so we'd like to
> know whether this is resolved or likely to recur.
>
> Thanks,
> Peter Farrell
> MarleyMoves Ltd

## Follow-up regardless of their answer

Nothing in the ops panel surfaces a failed card attempt to the office — the
customer simply doesn't appear to have paid. Worth a small "failed card attempts"
surface (or an alert) so a run of these is noticed the same day rather than in an
audit.
