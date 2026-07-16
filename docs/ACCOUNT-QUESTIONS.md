# Questions for Mel (accountant)

Running list — add questions as they come up; Peter formats an email from the
open ones when there's a batch worth sending. Keep each question self-contained
(context + why we're asking + what changes when answered) so the email writes
itself.

Company: MarleyMoves Ltd · VAT no. 520 2213 58 · VAT-registered with effect
from 01 June 2026 (HMRC VRT22C letter, issued 06 Jun 2026).

Status: 🔴 open · 🟡 asked, awaiting answer · 🟢 answered (record the answer inline)

---

## VAT

### 1. 🔴 Which months do our VAT quarters end? (the stagger)

**The question:** Which quarterly cycle did HMRC assign us — quarters ending
Mar/Jun/Sep/Dec, Apr/Jul/Oct/Jan, or May/Aug/Nov/Feb?

**Why we're asking:** The ops system tracks VAT owed quarter-to-date; the
approval letter doesn't state the stagger. It's on the Business Tax Account
(first return period end) or in your records from the VAT1.

**When answered:** Settings → "VAT quarter cycle" (currently defaulted to
Mar/Jun/Sep/Dec). One click.

**Answer:** _pending_

### 2. 🔴 What Flat Rate percentage goes on the returns — is the first-year 1% discount applied?

**The question:** We're on the Flat Rate Scheme (removals/transport sector rate
10%). Are you applying HMRC's first-year discount — i.e. **9% until 31 May
2027**, then 10%?

**Why we're asking:** The 1% discount is standard for the first 12 months from
registration but has to actually be used on the returns. At current volumes
it's worth ~£150+/month, and our daily VAT tracking should use whichever rate
you file with.

**When answered:** Settings → "VAT scheme" % field (currently 10). If 9%, we'll
diary the switch back to 10% for 1 June 2027.

**Answer:** _pending_

### 3. 🔴 FRS turnover method — invoice dates or cash received?

**The question:** Are our FRS returns calculated on the **basic turnover
method** (invoices raised in the period, by invoice date) or the **cash-based
method** (payments received in the period)?

**Why we're asking:** Pure timing difference (e.g. invoiced 29 Sep, paid 5 Oct
— which quarter does it land in?), but it decides whether our in-system
quarter-to-date figure matches your return exactly. We currently display
invoice-basis; with ~£33k invoiced-but-unpaid the two can differ materially at
a quarter boundary.

**When answered:** If invoice-basis — nothing to do, we already match. If
cash-basis — we'll switch the quarter figure to compute from payments received.

**Answer:** _pending_

---

## How to add a question

Copy this block under the right heading (add new headings — PAYE, Corporation
Tax, etc. — as needed):

```
### N. 🔴 <one-line question>

**The question:** …
**Why we're asking:** …
**When answered:** <what changes in the system / the business>
**Answer:** _pending_
```
