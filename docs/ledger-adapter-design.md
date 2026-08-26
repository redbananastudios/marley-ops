# Ledger adapter — design notes for gates 17 and 18

Written 2026-08-26 from a 6-scout code-binding pass over `lib/zoho.ts`, its 7 call
sites, and the Xero Accounting API 2.0 spec (via context7 `/xeroapi/xero-openapi`
and `/xeroapi/xero-node`). PRD §11.9 calls for exactly this before a build of this
size. Everything here is cited to a line or a spec, not to memory.

**Read this before writing any `lib/ledger/` code.** Six of the findings below
change the interface shape, and three are live-money defects that a straight copy
of Zoho's function list would ship.

---

## 0. The surface is smaller than the PRD's headline

§3.4 says "21 functions across 7 call sites". Measured:

- **13 are app-facing** and belong on the interface.
- `voidAndDeleteCreditNote`, `voidAndDeleteInvoice`, `deletePayment`,
  `deleteContact` have **zero** `app/` or `lib/` callers — test and script cleanup
  only. They do not belong on the production interface.
- `getVatTaxId` and `isPaymentGatewayActive` have no callers outside
  `lib/zoho.ts` — internal plumbing, stay private to the Zoho implementation.

---

## 1. The status enum is the single biggest leak (live-money)

Zoho returns **lowercase** `draft|sent|viewed|paid|partially_paid|overdue|void`.
Xero returns **uppercase** `DRAFT|SUBMITTED|DELETED|AUTHORISED|PAID|VOIDED`
(authoritative: `Invoice.Status` in `xero_accounting.yaml`).

> The spec's own `_autodocs/types.md` summary shows a WRONG shortened list that
> omits `AUTHORISED`. Do not copy that snippet.

The current code compares those raw strings in **11 places across 5 files**,
including:

- `lib/quote/accept-flow.ts:2770` — the branch that **marks a deposit paid**
- `app/api/cron/storage-billing/route.ts:125` — writes the literal into
  `storage_invoices.status`
- `lib/finance/invoices.ts:44` — `isRaised()`, a pure unit-tested function that
  excludes `void` and `draft`
- `app/(dashboard)/finance/page.tsx:48-56, 70` — `STATUS_PILL` keys and
  `inv.status === "void"`

**Decision: each adapter normalises to the Zoho lowercase vocabulary.** It is
already the repo's de-facto domain language, it is what the unit tests pin, and
normalising inside `xero.ts` means zero call-site churn. The alternative — a new
neutral enum — touches all 11 sites and every test that pins them, on money code,
for no behavioural gain.

Gaps that cannot be mapped 1:1, and must be stated rather than faked:

| Zoho | Xero | Resolution |
|---|---|---|
| `viewed` | no equivalent — only a `SentToContact` boolean | Unreachable under Xero. The /finance "Viewed" pill simply never shows. Do NOT synthesise it from `SentToContact`, which means something else. |
| `overdue` | no equivalent — derived from `DueDate < today` | `createInvoice` currently sets **no DueDate at all**. Either set one (gate 10 needs client terms anyway) or accept that Xero invoices never read `overdue`. |
| `partially_paid` | no equivalent | Derive: `AmountPaid > 0 && AmountDue > 0`. Safe, and matches what the pill means. |
| — | `SUBMITTED`, `DELETED` | `DELETED` is terminal for drafts and must be excluded alongside `VOIDED` wherever Zoho excludes `void`. |

## 2. `brands.ledger_branding_id` is structurally insufficient (schema change)

Zoho suppresses card per invoice: `payment_options: { payment_gateways: [] }`
(`lib/zoho.ts:244`) — the mechanism behind Peter's 2026-07-09 decision that card
fees are too high at balance values.

**Xero has no per-invoice equivalent.** Online payment services attach to a
**BrandingTheme** (`POST /BrandingThemes/{id}/PaymentServices`), and the invoice
picks a theme via `BrandingThemeID`. So "this invoice must not be payable by card"
becomes "raise it under a theme with no payment service attached".

That makes `BrandingThemeID` carry two orthogonal axes — **which brand**, and
**whether card is offered** — but gate 1 gave each brand exactly one
`brands.ledger_branding_id text` column (PRD §3.1, line 116).

**Minimum viable shape is two theme ids per brand** (card-enabled,
card-suppressed). This needs a migration and is a genuine correction to a gate-1
decision — flag to Peter rather than quietly widening the column.

## 3. Xero payments name a bank ACCOUNT, not a payment MODE (live-money)

Zoho: `payment_mode: "banktransfer"|"cash"|"creditcard"`.
Xero `PUT /Payments`: `{Invoice:{InvoiceID}, Account:{Code}, Amount, Date, Reference}`
— the Payment schema has **no** mode/method field at all.

So `mode` maps to three **org-specific** account codes (current account, cash in
hand, a takepayments clearing account). Getting it wrong **puts real customer
money in the wrong nominal account**.

`mode` is already a closed union threaded through the app (`RefundMode` at
`lib/payments/refund-vat.ts:39`, and `quotes.deposit_paid_method`), so: **keep
`mode` on the interface, resolve it to an account code inside `xero.ts` from
config.** Those codes are org-specific and must never be hardcoded.

Also: Xero payments carry no contact id — the contact is implied by the invoice —
so `input.customerId` becomes unused in the Xero path. Keep it on the interface
(Zoho needs it); document that Xero ignores it.

## 4. Reference lookup must use `where`, never `searchTerm`

Zoho has a server-side exact filter: `GET /invoices?reference_number=<ref>`.

Xero has **no `Reference` query parameter**. Two substitutes:

1. `where=Reference=="MMR001-DEP"` — `Reference` is an optimised where field
2. `searchTerm=MMR001-DEP` — documented as a **substring** text search

**Use the `where` clause, escape the value, and assert exactly one result — never
`[0]`.** `searchTerm` is a substring match, so `MMR001` matches `MMR0011-DEP`.
This is the same class as the stable-id lookup rule in `context/rules.md`, and our
references are exactly the colliding shape (`-DEP`/`-COM`/`-BAL` are three
invoices per quote).

`CreditNotes` has no `searchTerm` at all — `where` is the only option.

**Bonus available in Xero only:** creates accept an `Idempotency-Key` header
(exposed as `idempotencyKey` in the xero-node SDK). Worth using; Zoho has no
equivalent, so it stays an implementation detail rather than an interface concept.

## 5. Xero enforces unique Contact Name; Zoho does not

Xero rejects a duplicate `Name` with a ValidationException — *"The contact name is
already assigned to another contact. The contact name must be unique across all
active contacts"* — and **archived contacts still occupy the name**.

Current code calls `findOrCreateContact({ name: customerName })`, so the **second
"John Smith" fails outright**. Xero's own guidance is to key on `ContactID` and
set `ContactNumber`. Needs a disambiguation strategy decided at gate 17 — this is
a real behavioural difference, not a mapping detail.

## 6. The credit-note refund guard changes meaning under Xero

Zoho: `total_refunded_amount` → `available = total - total_refunded_amount`;
`available <= 0` returns the sentinel `"already_refunded"`.

Xero has **no refunds sub-resource**. A credit-note refund is `PUT /Payments` with
`{CreditNote:{...}}`, classified `ARCREDITPAYMENT`. There is no
`total_refunded_amount`; the guard must be rebuilt from `RemainingCredit`.

**But `RemainingCredit` is reduced by allocations to invoices as well as by
refunds.** So under Xero `available <= 0` no longer means "already refunded" — it
can mean "a human allocated this credit against another invoice in the Xero UI".
The sentinel must be redefined, or the adapter must read payment history. Left as
a straight copy, this silently reports a refund as already done when it wasn't.

Correct `Type` is **`ACCRECCREDIT`**. The OpenAPI autodocs snippet saying
`ACCRECREDITNOTE` is wrong.

## 7. Token store — sharper than PRD §11.7 trap 8

Confirmed and corrected: Xero access tokens last **30 minutes** (not 60), refresh
tokens **rotate on every use**, and the consumed refresh token keeps a **30-minute
grace window**. The grace makes a raced refresh recoverable but does **not** remove
the need for a persistent single-writer token row — two containers still race, and
env-var storage cannot work at all.

Zoho by contrast holds all auth state in three module-level per-process variables
and reads six `ZOHO_*` env vars through one `cfg()` gate (plus one ungated direct
read at `lib/zoho.ts:324`).

Design the persistent row at **gate 17**, so the interface has somewhere to put
it, even though only `xero.ts` uses it.

## 8. The flip strands every open Zoho invoice's status polling (live-money)

`getInvoiceStatus` is called on ids stored **months earlier**, at 7 sites:
`accept-flow.ts:1329` (deposit), `:1680` (commitment), `:2657` (balance),
`:2769/2788/2811` (`syncZohoPayments`, driven by the `zoho-deposits` cron), and
`storage-billing/route.ts:123`.

A single global `LEDGER_PROVIDER` switch means that from the moment of the flip,
**every one of those calls goes to Xero holding a Zoho invoice id**. Best case it
throws and the storage refresh logs `status_refresh_failed` forever. Worst case a
not-found is treated as transient, and **a customer who has actually paid never
gets marked paid**, while the cron keeps reporting a healthy run.

The history snapshot does not fix this — the archive is a frozen read model, it
does not poll. Two honest options:

- **(a)** Drain to zero open Zoho invoices before the flip, and assert that count
  in the runbook. Much smaller, and realistic given the flip is a chosen window.
- **(b)** Store the provider alongside each `zoho_*_invoice_id` and route
  `getInvoiceStatus` per row. The only option that is safe if (a) isn't achievable.

## 9. History snapshot — what /finance actually reads

Only **one** render-time surface reads the ledger live: `/finance`
(`listInvoices` + `zohoInvoiceAppUrl`). Every lead-history surface already reads
denormalised `quotes.zoho_*` columns from our own DB, so §3.4's "lead history
survives" is already true without the snapshot.

§3.4's column list is wrong in both directions:

- **Missing** three fields /finance renders: `invoiceId`, `customerName`, `balance`.
- **Lists a "VAT" field Zoho never returns to that page.** VAT is derived app-side
  by `invoiceVat()`/`vatFromGross()` against a `VAT_REGISTERED_FROM = "2026-06-01"`
  floor. **Storing a snapshot VAT column creates a second source of truth that
  will diverge from the same page's live rows.** Capture the provider's
  `tax_total` for audit only, never render it.

Other constraints:

- Key on `(provider, external_id)`. Never on `invoice_number` (provider-assigned;
  Xero reuses the numbering space) or `reference` (non-unique by construction).
- `app_url` must be **frozen at capture**, not reconstructed — the constructor is
  Zoho-shaped and `ZOHO_ORG_ID` will be removed from `app.env` at decommission,
  after which every archive row silently links to a broken page.
- Read through `fetchAllRows(..., { strict: true })`. PostgREST caps at 1000 rows
  and the default is fail-**soft** — a VAT quarter read with a plain select would
  silently truncate and understate the authoritative VAT figure.
- Brand attribution: use the bank-feed extraction shape `/(?:MM|PM)[RC]\d{3,}/gi`,
  **not** a prefix compare. Storage references are `MMS-...` with no brand input
  (`lib/storage-billing.ts:150-152`), so a naive `startsWith(refPrefix)` attributes
  **every** storage invoice — Pitmans lets included — to Marley, and it looks
  right. Leave NULL when there is no confident match and give NULL its own visible
  bucket. Ambiguity yields nothing.

**Ordering rule, belongs verbatim in the prod runbook:** `LEDGER_HISTORY_CUTOVER`
and `LEDGER_PROVIDER=xero` are set in **one** env edit and one restart.
Provider-first empties all history with no error; cutover-first puts an unverified
archive on the money read path while Zoho is still authoritative. Neither is
recoverable by re-running the snapshot once someone has read a wrong number off
the page.

## 10. Mechanical constraints that will bite the extraction

- **`zohoInvoiceAppUrl` is synchronous** and called inside JSX in a *non-async*
  component (`finance/page.tsx:98`, inside `.map()`). Making it async breaks the
  render. Keep a sync `invoiceAppUrl(id)`, or precompute `appUrl` onto each row.
- **`filterBy: "Status.Unpaid"`** is Zoho's own vocabulary hardcoded at
  `finance/page.tsx:149`. Re-express neutrally (`status?: "unpaid"`).
  `"Status.All"` is dead at every call site in the repo — drop it rather than
  porting it.
- **Errors must stay an `Error` subclass.** Both area-A call sites narrow with
  `err instanceof Error` and read only `.message`. `ZohoError` is never caught by
  type anywhere outside `lib/zoho.ts`, so a `LedgerError extends Error` is free.
- **`tests/lib/leads/delete-lead-history.test.ts:95` mocks by module path**
  (`vi.mock("@/lib/zoho", ...)`). Moving the module **silently un-mocks it** and
  the real client loads in tests. Must be updated in the same commit.
- `voidInvoice`'s call site has **no brand in scope** — `markLeadLostAction`'s
  `moneyQuotes` select (`leads/actions.ts:869`) omits `quotes.brand`, which exists.
- `/finance` already makes **up to 40 upstream calls per page load** (4 windows ×
  10 pages × 200 rows). Design brand as a **filter parameter on one call**, never
  a per-brand fan-out, or an admin page view doubles to 80.
- `voidInvoice`'s internal contract is under test: GET status first, return
  silently if already void, and **throw** ``Refusing to void ${invoiceNumber}:
  payment already applied`` when paid or partially paid. That string is read by a
  human in an ops alert — preserve it verbatim.

---

## 11. What the live Xero org actually shows (2026-08-26)

Peter's invoices have already been migrated into Xero and he showed the Invoices
list. Everything below is read off that screen, so treat the counts as a snapshot
of one page rather than a query — but the shapes are unambiguous and two of them
change the plan.

**The `Reference` field survived the migration.** The Ref column carries OUR
references verbatim: `MMR102-COM`, `MMR102-DEP`, `MMC002-COM`, `MMR069-DEP`,
`MMR079-BAL`. This is the single most important fact for the cutover. Every
`quotes.zoho_*_invoice_id` we hold is a **Zoho** GUID and resolves to nothing in
Xero (Xero minted new ids — the Number column reads `INV-000271` and counts down),
so without a re-map the flip strands every stored id. Because the reference
survived, `findInvoiceByReference` — which already exists, and under Xero must use
`where=Reference=="..."` per §4 — is a working re-map path. **This makes §8's
option (b) achievable rather than aspirational**, and it is now the recommended
route: stamp each row with its provider, and re-map by reference rather than by id.

**Reference formats in the wild are wider than the bank-feed shape.** Also visible:
`IMV007-BAL`, `IMV008-BAL` (the iMovE import) and `MM-260709-308-BAL` (an older
format). None of those match `(?:MM|PM)[RC]\d{3,}`, so §9's brand attribution
leaves them NULL. That is the correct direction — ambiguity yields nothing — but it
means the archive's NULL bucket will be substantial rather than a rounding error,
and whatever renders it must present NULL as its own visible category rather than
implying Marley.

**Every visible row reads `Awaiting Payment` with `Paid 0.00`,** and the tab counts
show 198 awaiting payment out of 199. Among them is `MMR069-DEP` at £100 dated
21 Aug. If payment history genuinely did not migrate — Peter to confirm; it is also
consistent with only OPEN invoices having been brought across — then pointing
`getInvoiceStatus` at Xero would read paid deposits as unpaid at
`accept-flow.ts:2770` and `storage-billing/route.ts:125`, and the app would chase
customers who have already paid. **This is not a reason to delay the adapter; it is
a reason the per-row provider stamp is mandatory rather than optional.** A
pre-cutover invoice must keep being polled against the system that holds its
payment record.

**Due Date equals Invoice Date on every visible row.** §1 recorded that `overdue`
is unreachable under Xero because `createInvoice` sets no DueDate — true for
invoices WE raise, but not for these. Migrated invoices carry a due date already
past, so a Xero-backed `/finance` would render essentially the whole back catalogue
in the overdue tone on day one. Worth knowing before anyone reads that page and
concludes the business is in trouble.

**Xero's own invoice reminders are switched on.** The list header states reminders
are enabled and will send one day before due, then 7 and 14 days after. With every
migrated invoice already past due, that is a second, independent chase rail
pointed at the same customers our own ladder chases — and, if the payment history
did not migrate, aimed at people who have already paid. It is a live customer-comms
hazard that exists **right now**, independent of any code here. Flagged to Peter
2026-08-26 with a recommendation to turn Xero's reminders off and leave chasing to
Ops, which is the only system that knows what has actually been paid.


## Decisions needed from Peter before gate 18 can finish

1. **Branding themes** (§2) — two theme ids per brand means a migration widening
   `brands.ledger_branding_id`. Confirm the card-enabled / card-suppressed split.
2. **Bank account codes** (§3) — the three Xero account codes for bank transfer,
   cash, and the takepayments clearing account.
3. **Contact-name collisions** (§5) — what to do with the second "John Smith".
4. **The flip** (§8) — drain open Zoho invoices to zero first (a), or store
   provider per row (b)?
5. **Invoice PDFs** — they are Zoho's own VAT documents and die with the account.
   Worth archiving to a private bucket? UK VAT record retention is commonly cited
   as six years; confirm with the accountant.

**Also outstanding: there are no Xero credentials in this environment** —
`credentials.env`, `.env.local`, `.env.staging` and `.env.e2e` all contain zero
`xero` references. Per PRD §12 the adapter is built and fixture-tested without
them; a live-org test needs `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` plus the one-off
authorisation run.
