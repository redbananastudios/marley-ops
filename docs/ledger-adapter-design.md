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

**Reference formats in the wild are wider than one pattern.** Also visible:
`IMV007-BAL`, `IMV008-BAL` (the iMovE import) and `MM-260709-308-BAL` (the legacy
scheme). **Correction to §9:** that section named only `(?:MM|PM)[RC]\d{3,}`, but
`lib/bank-feed/match.ts` REF_PATTERNS carries a *second* pattern — `MM-\d{6}-\d{3}`
— and the legacy form does carry its brand pair, so `MM-260709-308-BAL` IS
attributable to Marley. The archive must mirror **both** patterns, not the first
one alone; `scripts/ledger-snapshot.mjs` does. What genuinely stays NULL is the
iMovE set and storage's `MMS-<hash>` references, which are minted with no brand
input at all — which is also exactly why a `startsWith(ref_prefix)` compare must
never be used here: it would attribute every storage invoice, Pitmans lets
included, to Marley, and it would look right. Whatever renders the archive must
give NULL its own visible category rather than implying Marley.

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

> **Superseded in large part by section 12 (2026-08-26).** Four of the five below
> were answered by a verified, adversarially-reviewed research pass. Read section 12
> first and treat the list here as the record of what WAS open, not as outstanding work.

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
---

## 12. Answers (2026-08-26) — verified research pass, adversarially reviewed

Nine agents: four Xero-API researchers each independently refuted by a skeptic, plus
a read-only code analysis of the flip. **No claim survived on prose alone** — every
one below carries either a quoted Xero doc sentence or a `file:line`. Where a claim
could not be closed it is marked as such rather than smoothed over.

Two research-process facts worth keeping: `developer.xero.com` and `central.xero.com`
are fully client-rendered and CAPTCHA-protected respectively, so the doc text was read
through the Gatsby `page-data.json` payloads and a rendering proxy, not from a plain
fetch. And the OpenAPI `_autodocs/*` summaries were wrong **again** — a third instance
after the two §1 already records: context7 gives the contact record-filter path as
`/Contacts/ContactNumber/{ContactNumber}`, while `xero_accounting.yaml` defines
`/Contacts/{ContactNumber}`. Implementing from the summary produces a 404. Treat
`_autodocs` as unusable in this spec.

### 12.1 Card — Xero CAN point "Pay now" at our existing takepayments rail

Xero never processes card money itself; it renders a Pay Now button that hands the
customer to a payment service attached to the branding theme. The built-in UK options
are Stripe, GoCardless, PayPal and Square. **takepayments is not one of them** — but a
fourth type is, and it changes the answer:

> `PaymentServiceUrl` — "The custom payment URL. This URL should contain placeholders
> that will be replaced with relevant invoice data. These placeholders are
> `[INVOICENUMBER]`, `[CURRENCY]`, `[AMOUNTDUE]` & `[SHORTCODE]`"

So Xero's button can deep-link into an `ops.marleymoves.co.uk` page that mints the
signed takepayments form — **one card rail, not two**. It has to be a page of ours
rather than a direct link because the takepayments HPP "only accepts a browser POST;
there is no link-minting API" (`app/q/[token]/pay-card-button.tsx:4-7`).

Access caveat, and it decides *who* configures it: creating a payment service **via
the API** is closed to us — "Payment service details can only be accessed by
specifically certified payment service partners", gated behind Xero's revenue-share
agreement and App-partner review. The **UI** route (Settings → Payment Services → Add)
appears generally available; Xero Central publishes "Add a payment service that uses a
custom URL", and five independent vendor integration guides describe the same
self-serve path. The article body itself was CAPTCHA-blocked, so this is
well-attested but not read from Xero's own words. **Peter configures it once in the
Xero UI; we never call the PaymentServices API.**

If instead card is left OFF in Xero, nothing needs building: `disableOnlinePayments`
becomes a no-op and the /q rail is unchanged. **§2's "two branding themes per brand"
is only required if card is enabled AND must be suppressed per invoice.**

### 12.2 Bank accounts — discover them, do not ask for codes

`PUT /Payments` accepts **either** `Account.Code` or `Account.AccountID`, and the
account "needs to be either an account of type BANK or have enable payments to this
accounts switched on".

- **Send `AccountID`, not `Code`.** Xero's own doc says "not all accounts have a code
  value", and Code is user-editable in the Chart of Accounts UI. AccountID is the
  stable id — which is also what `context/rules.md`'s "look a record up by its stable
  id" demands. Keep Code for display only.
- **The discovery filter is a union: `Type=="BANK" OR EnablePaymentsToAccount==true`.**
  Filtering on the flag alone drops real bank accounts (Xero's own `GET /Accounts`
  example returns a `Type: BANK` account with `EnablePaymentsToAccount: false`);
  filtering on `Type=="BANK"` alone misses a clearing account modelled as a
  current asset with payments switched on. Fetch `/Accounts` unfiltered — Xero warns
  to "restrict your queries to simple == operations" — and filter client-side.
- **There is no method field to write.** `PaymentType` is `readOnly`, and
  `Details`/`Particulars`/`BankAccountNumber` are supplier/AP fields ("The information
  to appear on the supplier's bank account"). The account choice *is* the record of
  the rail. Do not put the rail in `Reference` either: §4 needs `Reference` to stay
  exactly the quote ref for the `where=Reference=="…"` re-map, and §4 wins.
- A BANK-type clearing account is the right home for card receipts — Xero Central
  documents the same shape for Stripe payouts. It must be created as `Type=BANK`, or
  the payment PUT needs the flag set manually and Xero's payout reconciliation is
  unavailable.
- **The mode resolver should be an exhaustive `switch` with a `never` guard**, not a
  ternary chain. `zohoMode` (`accept-flow.ts:1290`) is a fallback map — anything that
  is not "cash" or "card" becomes "banktransfer". Correct by construction today
  because the input unions are closed, but a fourth rail would silently post to the
  bank account instead of failing to compile.

**Verified in our code:** all three `recordInvoicePayment` call sites derive the mode
from a closed three-literal union, and the one path without a real method (the poll
cron) passes `recordInZoho: false`, so it never writes a payment at all.

### 12.3 Contacts — key on `clients.id`, never on a name or a search rank

Peter's "we use email/phone as the key so names may duplicate" is exactly right, and
Xero agrees about names:

> "We recommend all developers use ContactID to uniquely reference contacts in Xero
> and do not rely on ContactName as a way to reference contact data uniquely in Xero."

`ContactNumber` is API-settable, max 50 chars, documented as "a custom identifier
specified from another system", and fetchable as `GET /Contacts/{ContactNumber}`.
`MMOPS-{clients.id}` is 42 chars and stable across name, email and phone changes —
which is what our clients dedupe spine already guarantees.

Resolution order (each step exact-match; none returns a ranked list to choose from):

1. stored ContactID → `GET /Contacts/{ContactID}`, assert `ContactStatus == ACTIVE`
2. `GET /Contacts/MMOPS-{clients.id}`
3. `GET /Contacts?where=EmailAddress="…"` — adopt **only** on exactly one ACTIVE row;
   zero → create; two or more → create nothing and alert. Ambiguity yields nothing.
4. create with **`PUT /Contacts`, never `POST`** — PUT is documented to error on a
   ContactName/ContactNumber match, while POST is "create or update" and could
   silently retarget another customer's contact
5. on a duplicate-name ValidationException, retry once with a **deterministic** suffix
   from the stable id (`John Smith (a1b2c3d4)`) — never a counter, which mints
   `(2)`, `(3)`, `(4)` for one customer across crash-retries

Three corrections the skeptic added, all material:

- **Never blind-stamp ContactNumber on an email-matched contact.** Xero's own
  best-practice page: "please check the existing contacts in Xero to make sure that
  they don't already have a contact number assigned from another app integration."
  Read it first and skip when present.
- Step 3 runs against a default GET, which **excludes archived contacts** — so it can
  return zero and fall through to a create that then collides on the name.
- Branch on **HTTP 400 + `Type == "ValidationException"`**, never on the error string:
  that wording is quoted from third-party integrator docs, not from Xero.

**Interface consequence for gate 17/18:** `findOrCreateContact` must gain the stable
`clientId`. All five call sites already have it in scope (`accept-flow.ts:1088/1574/2510`,
`raise-storage-invoices.ts:415`, `refund-vat.ts:249`) — but `quotes.client_id` is
**nullable**, so the null case needs an explicit answer rather than a fallback to name.

**Two things must be probed against a live org before gate 18 closes**, neither
expensive, both changing the failure handling: (a) does archiving a contact free its
name — §5 asserts it does not, Xero's own error text says "unique across all **active**
contacts", and the two contradict; (b) what `POST /Contacts` actually does on a name
collision with no id supplied.

### 12.4 Staging — the Demo Company, on a separate app, asserted by CLASS not by id

Xero has no dedicated sandbox. Two non-production options: the **Demo Company** (free,
API-writable through the ordinary OAuth flow, resets every **28 days**) and a **trial
org** (30 days then billing required, arrives empty, and explicitly **cannot be
reset**). Use the Demo Company.

- **Register a separate developer app for staging.** Xero meters connections and API
  volume per app and apps "cannot share connection counts or API volume used, even if
  they are from the same developer", so staging can never eat prod's daily limit. It
  also makes the boundary physical — the same property Zoho gets from a Self Client
  under a separate login.
- **Assert `Organisation.Class === "DEMO"` before any write, not a pinned tenant id.**
  The Zoho pattern hardcodes `DEMO_ORG = "20117092566"`, but a Xero demo tenantId may
  change on every reset, so a literal would break each cycle and tempt someone to edit
  it. A class assertion also fails safe against a tenant nobody has seen before.
- **What the 28-day reset destroys is configuration, not test data:** the bank/cash/
  clearing accounts (§12.2), any branding themes (§12.1), the VAT rates, and the
  `ledger_tokens` row's `refresh_token` **and** `tenant_id`. So the re-authorisation
  script must upsert both, and an idempotent `scripts/xero-demo-bootstrap.mjs` should
  rebuild the org state — otherwise staging is a manual re-setup every 28 days and
  someone will eventually skip a step silently.
- **Read `tenant_id` per call, never latch it.** Xero: "Always treat xero-tenant-id as
  dynamic per request and never cache it globally across threads." `lib/zoho.ts`
  latches its auth state in module-level variables; the Xero adapter must not.
- **Constraint with no workaround:** you "can not invite other users to access your
  demo company". Connor and Mark cannot be given a login to a Xero staging org the way
  they could to Zoho's Demo Removals. If anyone but Peter must eyeball staging
  invoices, that alone forces a trial or paid org.
- **Check before the cutover window, not inside it:** "each organisation or practice is
  limited to connecting a maximum of two uncertified apps." If Connor's live org already
  has two (a bank feed, a receipt scanner), the prod app is refused at consent.

Rate limits are per tenant: 5 concurrent, 60/min, 1,000/day on the free Starter tier.
Worth noting against §10's finding that /finance already makes up to 40 upstream calls
per page load.

### 12.5 The flip — per-INVOICE-SLOT provider stamp (sequence B)

Sequence A (drain open Zoho invoices to zero, then flip globally) is **rejected**: the
open set is not a backlog, it is a flow. The T-7 chase raises a new balance invoice for
every accepted booking and storage bills every period, so draining means suspending
invoice raising — an outage, not a window. Its only irreversible cost is worse: every
invoice voided to force the drain leaves the customer holding a PDF for money they are
then re-invoiced for under a different number.

**A per-quote stamp is definitively insufficient**, which was not obvious:
`ensureCommitmentInvoice` (`accept-flow.ts:1604`) and the T-7 balance raise
(`:2550`, driven by `chase/route.ts:1139-1141`) both mint **new** invoice ids on quotes
accepted long before the flip, and the supersede path (`:349-357`) copies an old
provider's deposit invoice id **and contact id** onto a brand-new quote. Zoho deposit
beside Xero balance on one quote is the **normal** state of every live booking crossing
the flip, not an edge case. Columns needed: four on `quotes`
(deposit/commitment/balance/contact), one on `storage_invoices`, one optional on
`card_payments`, plus a key inside `refund_queue.held` jsonb.

No constraint is in the way — every `zoho_*` id column is bare nullable text with no
unique index, NOT NULL or FK. Prefer **nullable + a check** (`id is null or provider is
not null`) over `not null default 'zoho'`: the default is honest for the backfill but
becomes a silent lie the first time a write forgets the column.

**The contact id is the sharpest edge.** `isRealZohoId` only tests non-null and
`<> 'pending'` — it has no concept of which provider minted the id — so all three raise
paths hand a Zoho contact id straight to Xero's `createInvoice`. The commitment path is
worst: it self-heals from the customer's own `/q` page load, so a customer refreshing
their booking page generates a fresh failed create and a fresh ops alert every time.

**The scheduling fact that actually decides this:** there is exactly one promotion to
prod (18 September) and prod migrations are human-run over SSH. The question is not
"when do we flip" — it is **"does the stamp migration make the 18 September train"**.
If it does, the flip is a low-drama env edit on any day after the 18th. If it misses,
the only fallback is routing by id shape (Zoho ids are numeric, Xero ids are GUIDs),
which is cheap and fails closed but rests on an **inference about an opaque third-party
id format** sitting on money code. That inference is provable — once the snapshot runs,
one query over `ledger_invoice_archive` shows whether any stored Zoho id is GUID-shaped.

**Reject explicitly: deriving the provider from a DATE.** `quotes` has
`balance_invoice_created_at` and `commitment_invoice_created_at` but **no**
`deposit_invoice_created_at`, and the supersede path copies an old deposit id onto a
quote whose `created_at` is after any cutover. Cheaper than a column and wrong in
exactly the rows that matter.

### 12.6 What was fixed immediately, because every sequence needs it

The two automated pollers were **silent**, and design §8 understated it: they did not
merely fail quietly, they reported healthy runs that then **cleared their own alarm**.

- `syncZohoPayments` had three bare `catch {}` — no log, no counter, no alert. The
  cron's `checked` counts rows **examined**, not statuses **read**, so a total provider
  outage returned `{checked: 25, settled: 0}`, byte-identical to a day nobody paid;
  `runCron` saw no throw and called `resolveOperationalIssue`.
- `storage-billing` logged a warning the run summary never carried.

Both now count reads and failures separately and surface them, and a sweep in which
**every** read failed returns `ok: false` via the shared `blindSweepFailure` helper —
so a blind run is a failed run, while a partial failure stays a visible count rather
than an alarm people learn to ignore. Without this, the first evidence of a bad flip
would have been a customer who had already paid receiving a chase.

**One thing that made §8 less alarming than feared:** `syncZohoPayments` passes
`recordInZoho: false` at all three branches, so it never records a payment against a
stale id. §8's hazard is real but confined to the **read** direction.

### 12.7 Still genuinely open

1. **Does Marley want card offered on Xero invoices at all?** (§12.1) Peter's call —
   everything else about card is now settled either way.
2. **Which three accounts** the picker's rails map to, once credentials exist (§12.2).
   Not a lookup for Peter: three choices from a list we render.
3. **Null `quotes.client_id`** at the contact call sites (§12.3).
4. **`clients.merged_into_id`** — a client row can be tombstoned after its
   ContactNumber is already stamped into Xero, leaving a contact keyed on a dead id.
   Needs a rule (follow the merge, or re-stamp).
5. **Invoice PDFs** — Zoho's own VAT documents die with the account. Archive to a
   private bucket? UK VAT retention is commonly cited as six years; confirm with the
   accountant.
6. **Two live-org probes** before gate 18 closes (§12.3): does archiving free a name,
   and what does `POST /Contacts` do on a name collision.
