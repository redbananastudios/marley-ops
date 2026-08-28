# PRD — Multi-brand Marley Ops (Pitmans Removals & Storage first)

**Baseline:** `staging` @ `d84fcd7` (2026-08-25, pulled into the working worktree at build start; only a docs-only Current State roll past `6ae3ba3`). **Prod, `master` and `staging` are all level — no promotion gap, zero open QA findings, and the QA loop now runs end to end on its own** (Sonnet audits, first-pass repair firing). Every gate's diff is measured against a prod that matches.

Folded in since first drafting: `#70`–`#72` (retired-route redirect, h8 teardown, slot range, artifact-only role-agent evidence), and the 2026-08-25 wave — **`#73`/`#74` whole-quote bank matching with migration `0103`**, the repair tier proving itself live (`#79`/`#80`, human-reviewed in `#82`), and two prod promotions.

**The nightly QA loop pushes to `staging` continuously, so re-fetch and re-read `qa/findings/open/` at build start** rather than trusting this line — it moved three times while this plan was being written.

Committed as `docs/multi-brand-prd.md`, following the `payments-policy-v2-prd.md` convention — the QA role agents read the repo, so acceptance criteria must travel with the code.

---

## 1. Context

Marley Moves takes over Pitmans Removals (Blandford — Mark Pitman, Companies House 08280877, ~30 years trading). **Transfer starts 21 September 2026; full takeover and Ops go-live 28 September.**

Pitmans runs inside the existing Marley Ops instance, not a second copy, because **the crew, the vans and the bank account are shared**. A separate deployment would split one capacity pool across two diaries, which is how you double-book a crew.

Marley Ops is single-tenant by construction. There is no brand column anywhere, "Marley Moves" is a literal string across ~65 files, and every brand colour is either the `mm-red` token or a hardcoded hex. This project introduces a **brand layer**, built for N brands.

Two facts keep it small:

1. **MarleyMoves Ltd trading as Pitmans Removals & Storage.** One legal entity, one VAT registration, one ledger, one invoice sequence, one client spine, **one bank account**. Brand is presentation and attribution, not financial isolation.
2. **The group mark is functional.** "Part of the Marley Group" exists so a customer isn't shocked by a Marley Moves bank account or a Marley van. Treat it as a required disclosure, not decoration.

### The single-brand invariant

**With one active brand, Marley Ops looks and behaves exactly as it does today.** Chips hidden, filters hidden, colours untouched. The brand UI appears only when a second brand is activated, driven by `listActiveBrands().length > 1`.

This is the most important structural decision in the plan **for the brand layer**: every brand-UI gate is provably non-regressive for the live system, activation is a single data switch rather than a big-bang UI change, and deactivating the Pitmans row instantly reverts the entire brand UI. A feature flag driven by data.

**The invariant governs the brand layer only.** The payment-policy additions (§3.10 — small-job full ask, late-booking simultaneous balance, pay-in-full at commitment, the office payment link, the commercial path) are deliberately **not** behind it: they are intended, additive changes to live Marley behaviour that go live at the prod promotion, brand UI or no brand UI. The invariant means "prod's brand UI cannot change until activation", never "prod cannot change". The residential ladder itself — deposit, confirmation signature, commitment, balance — is **unchanged for both brands**.

---

## 2. Decisions

| Area | Decision |
|---|---|
| Legal entity | MarleyMoves Ltd t/a Pitmans Removals & Storage. All future brands also trading names |
| Customer-facing brand | Pitmans identity kept **exactly**, plus "Part of the Marley Group" anywhere the Pitmans logo appears |
| Single-brand invariant | One active brand → UI identical to today. Brand UI appears only at two or more |
| Access | Everyone sees both brands. No brand-scoped RLS. **Mark Pitman gets `admin`** — the only office-capable role (§11.10) |
| Pricing | Identical rate card. `business_settings` stays a singleton |
| VAT | Pitmans is VAT registered → forward-booked prices carry unchanged |
| Deposits | **£100 deposit KEPT and extended to both brands** (Peter, 2026-08-25 pm, reversing the same-day retirement). Today's ladder for everyone, plus: small jobs ≤ £300 pay in full at accept; late bookings get the balance raised alongside the ask; pay-in-full offered at the commitment step. Pitmans forward bookings import unpaid |
| Crew | Self-employed contractors → existing self-billing unchanged |
| Card payments | **As today** — card at accept and on payment states, unchanged for Marley; **off for Pitmans initially** (bank transfer only, via the brand switch). NEW: office "Send payment link" action for card-enabled brands |
| Bank account | **One account, Marley Moves, for both brands** — `BANK_DETAILS` unchanged; the `/q` page and payment emails explain it |
| Migrating | Forward bookings, live storage lets, vans, staff records. **Not** past customer history |
| Import refs | Fresh `PMR`/`PMC`; any original Pitmans reference stored alongside |
| Imported jobs | Marked in the UI **until completed** |
| Ledger | `lib/ledger/` adapter. **Zoho and Xero implementations both in scope.** Xero live before 28 Sept |
| Zoho history | Snapshot invoices to our own table **before** the switch |
| Invoice branding | Xero branding themes per brand. No in-house invoice PDFs |
| Terms | **Current terms match behaviour — no interim version needed** (the deposit stays; the small-job/late asks fit the existing "if yours is different" clause). One new version at gate 15: unified from Pitmans' proven wording, brand-neutral body, per-brand rendering. Drive = authoring centre of truth (§3.7) |
| Brand 3 | Data-driven. Settings card allows **editing safe display fields**; creating brands stays a migration |
| Cross-brand docs | A **`group` pseudo-brand** row — day sheet, `/join`, `/manual`, contractor statements |
| Manual leads | Brand **required, no default**; editable until a ref is issued, then locked |
| Storage lets | Brand from the customer's originating lead, falling back to the site |
| Vehicles | `brand` = livery only. **Soft warning at allocation** on mismatch, never blocking |
| Reviews | Pitmans completion emails point at **Google** |
| Reporting | Dashboard tiles keep **one combined headline** with an `M n · P n` sub-line beneath (2026-08-25); filter across other pages; comparison view later |
| Additional Charges | **In scope** — internal uplift with a reason, absorbed into the customer's "Your Removal" line |
| Man-and-van tier | **After cutover** |
| Growth suite | Already removed (`13f624e`) — out of scope |
| Manuals | Dual-brand section added **last** |
| Cadence | Daily-ish. **One PR per gate**, merged to `staging` |

### UI decisions

| Element | Decision |
|---|---|
| Diary fill | **Marley:** charcoal removals, red surveys/pack. **Pitmans:** blue removals, yellow surveys/pack |
| Diary brand signal | Brand initial in the meta line. **No left bar** — the fill already says the brand |
| Brand chip | **Filled monogram square** (2026-08-25): 20px square, brand-colour fill, white initial — charcoal `M`, blue `P`. Full brand name on hover and in detail-page eyebrows. Unmistakably distinct from pill-shaped status badges |
| Unconfirmed day on diary | **Hollow until confirmed** (2026-08-25): dashed brand-colour outline + brand-colour text while `date_confirmed_at` is null; fills solid on confirmation. Office sees confirmed days at a glance; crew never see unconfirmed jobs (night-before sheets only) |
| Chip when filtered | **Hidden** when filtered to one brand — the segmented control already says which |
| Filter | Segmented `All / Marley / Pitmans`, always visible, **defaults to All** everywhere |
| Pitmans colour | **Blue primary** for UI; **yellow** for large flat areas (email header band, diary survey blocks) |
| Token pages | **Full palette** — no Marley red on a Pitmans page |
| Group surfaces | Charcoal neutrals, no brand colour |
| App chrome | Unchanged — sidebar, `BrandMark`, login, tab title, PWA manifest all stay Marley Ops |

### Corrections carried into this plan

- **The ingest endpoint needs no relaxing.** `fromPostcode`, `toPostcode` and `propertySize` are already `optionalText()`; only `leadId`, `name` and one of phone/email are required. Downstream is safe — `lib/quote/pricing.ts` treats miles as null-until-calculated and the maps lookup degrades rather than failing. The only gap is visibility.
- **On the calendar, fill encodes `appt_type`, not status.** Status colour lives on list badges. My earlier "status keeps the fill" was wrong for that surface.
- **`scheduler-view.tsx`'s doc comment is stale** — it describes surveys as a white outline chip, but the live constants are a solid red fill with white text. Verify visually on staging before styling.
- **Zoho cannot do per-brand logos on the free plan** (org-level logo; Branches is a paid Books feature), and free Zoho Invoice caps at **500 invoices/year** — a forcing issue independent of branding, resolved by the Xero move.
- **Already fixed on `staging`, not pre-work:** the e2e gate gap (`9b7cee1`), QA-20260823-01 crew date-change silence (`11ba0b5`), growth + Job Board removal (`13f624e`).

---

## 3. Architecture

### 3.1 `brands` table

```
brands(
  slug              text primary key,        -- 'marley' | 'pitmans' | 'group'
  name              text not null,           -- 'Pitmans Removals & Storage'
  short_name        text not null,           -- 'Pitmans'
  initial           char(1),                 -- 'P' | 'M'  (diary meta line)
  group_line        text not null,           -- 'Part of the Marley Group'
  legal_line        text not null,
  ref_prefix        text unique,             -- 'MM' | 'PM'  (null for 'group')
  colour_primary    text, colour_accent text,
  logo_url          text, group_logo_url text,
  email_domain      text, hello_from text, accounts_from text, reply_domain text,
  sms_sender        text,
  phone             text, address text, website_url text, review_url text,
  terms_url         text,
  base_location     text,                    -- null → business_settings.base_location
  card_payments_enabled boolean not null default false,
  ledger_branding_id    text,                -- Xero BrandingThemeID (org-specific, never hardcoded)
  resend_template_ids   jsonb not null default '{}'::jsonb,
  active            boolean not null default true,
  sort_order        int not null default 0
)
```

RLS mirrors `business_settings` — read by `is_staff()`, write by `is_admin()`.

`lib/brand.ts`: `getBrand(slug)` with per-request reads and **no caching layer**, exactly like `getBusinessSettings()` (corrected at gate 1 — the earlier "cached" wording was wrong on both counts: settings has no cache either, and a cached brand surviving an activation flip is precisely the failure the parity spec exists to catch); `listActiveBrands()` (excludes `group`), **`isMultiBrand()`** — the single-brand invariant — `GROUP_BRAND`, `DEFAULT_BRAND = 'marley'`.

**Pitmans seed** (from their live site): `Pitmans Removals & Storage`, initial `P`, phone `01258 858564`, `Uplands Business Park, Blandford Heights, Shaftesbury Road, Blandford Forum, Dorset DT11 7UZ`, `pitmansremovals.co.uk`, Google review URL. Legal line: `Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266. VAT 520 2213 58.`

### 3.2 `brand` columns

`leads.brand` is the source of truth, denormalised to `quotes` and `appointments` so the diary colours a row without a join.

- `leads.brand text not null default 'marley' references brands(slug)` — backfill existing to `'marley'`
- `quotes.brand`, `appointments.brand` — set from the parent lead at insert
- `storage_sites.brand`, `storage_lets.brand` — let inherits from the lead, falls back to the site
- `vehicles.brand` **nullable** — livery only
- **Not** on `clients`, `staff`, `appointment_assignments`, `business_settings`

**Shared client spine is deliberate.** `clients.phone_e164`/`email_norm` are globally unique. Under one legal entity, a person contacting both brands is **one client with two leads**, and every customer-facing output takes brand from the *lead*.

### 3.3 Reference counters

Replace the two fixed sequences with `brand_ref_counters(brand, kind, n)`. `next_quote_ref(kind, brand)` does an atomic `update … returning n` under the row lock → `PMR001`, `MMC042`. **The one-arg signature is DROPPED, not kept as a wrapper** (corrected at gate 1 — the code wins per §10): a wrapper beside the two-arg would make PostgREST's named-argument resolution of `rpc('next_quote_ref', { kind })` ambiguous (300 Multiple Choices), breaking every existing call site. Instead the second argument is `brand text default 'marley'`, which keeps those call sites working entirely unchanged. Current sequence values migrate in.

The quote ref **is** the bank-transfer reference `lib/bank-feed/` reconciles against, so a distinct prefix gives per-brand revenue attribution for free.

### 3.4 Ledger adapter

`lib/zoho.ts` exposes **21 functions across 7 call sites**. Extract `lib/ledger/` with one interface, `zoho.ts` and `xero.ts` implementations, chosen by config so staging can run one while prod runs the other during migration. `createInvoice` gains a `brand` argument carrying `ledger_branding_id`.

Call sites: `finance/page.tsx`, `leads/actions.ts`, `app/actions/booking-change.ts`, `api/cron/storage-billing`, `lib/payments/refund-vat.ts`, `lib/quote/accept-flow.ts`, `lib/storage/raise-storage-invoices.ts`.

**Zoho history snapshot before cutover** — invoice number, reference, amount, VAT, status, date into our own table, so `/finance` and lead history survive. Effectively impossible once the account lapses.

### 3.5 Comms

Thread `brand` through `lib/comms/sender.ts` (`MARLEY_EMAIL_DOMAIN`, `HELLO_FROM`, `accountsFrom()`, `ownerFrom()`), `branded-shell.ts` (`LOGO_URL`, colour, `STANDARD_FOOTER`), per-template copy in `lib/comms/*-email.ts`, SMS copy in `templates.ts`. `scripts/create-resend-templates.mjs` gains `--brand` so a second set generates from the same source, ids into `brands.resend_template_ids`.

Pitmans email header band is **yellow**, buttons and links **blue**.

**`sender.ts` is the highest-risk file in the project** — a wrong from-address is instantly visible to a live customer.

**Required disclosures:**
- Pitmans payment and bank-transfer emails state payment goes to MarleyMoves Ltd, name the account, and give the `PMR###` reference.
- Booking confirmation and pre-move comms note a Marley Moves vehicle or crew may attend.

### 3.6 PDFs

Brand-specific: `lib/quote/pdf-client.ts`, `contract-docdef.ts`, `completion-cert-docdef.ts`, `job-sheet-docdef.ts`. Filenames become `Pitmans-Quote-PMR001.pdf`.

Group-branded: `lib/crew-sheet/daily-docdef.ts` (a crew day spans brands) and `lib/staff/statement-docdef.ts` (crew are engaged by the legal entity).

**The rule:** documents about a *job* carry that job's brand; documents about a *person or the group* carry `group`.

### 3.7 Terms

**One new terms version ships in this project, and Drive is the authoring centre of truth (Peter, 2026-08-25).**

With the deposit reinstated, the **live terms already match behaviour** — `v2-2026-08-11.md` describes exactly the deposit-commitment ladder both brands will run, and its *"The deposit is £100 for most moves. If yours is different, the amount is shown on your quote and on the payment page"* clause already covers the small-job and late-booking asks. No interim rewrite is needed.

- **Gate 15 — the unified brand-neutral document** adopting Pitmans' proven wording: says "the Company", carries MarleyMoves Ltd's legal identity, brand name/logo/contact from the rendering shell, `terms_url` per brand. Ask the legal read to confirm part-loads, long-distance and storage are covered, and that its cancellation clause matches the v2 25% re-booking model (§11.10).

**The Drive workflow already exists — use it, don't rebuild it.** `scripts/publish-legal.mjs` distributes every published version to Google Drive (`Companies/MarleyMoves Ltd/06 Contracts & Legal/<Document>/Published/`) as styled HTML precisely so the *"draft in Drive, solicitor redlines, freeze to the repo"* loop works, plus an Obsidian mirror. Drive is where the text is authored and redlined; `legal/` is the immutable frozen snapshot customers verifiably sign (`0093_signature_terms_snapshot.sql` preserves what each customer already agreed); `publish-legal.mjs` pushes outward and never reads back, so no copy can compete. **The website following the same terms** means `marleymoves.co.uk`'s terms page renders the published artifact rather than its own copy — the website is a separate repo, so that sync is flagged as a follow-up task there, with the published HTML in Drive as its feed.

### 3.8 Ingest

- **Brand derives from the secret, never the payload.** Per-brand ingest secrets; a body `brand`, if present, must match or 401.
- **`leads_external_lead_id_unique` becomes unique per brand** — two sites will both mint id `1234` eventually, and today the second is silently swallowed as a duplicate. A real data-loss bug.

Their form maps cleanly, including **"Where did you hear about us?" → `leads.referrer_answer`** (column exists).

**The monitoring gap is the real design problem.** Marley has two disjoint rails (push *and* Sanity pull), so a broken push is detectable over a channel the push can't silence. Pitmans on WordPress would be **push-only**. So the integration is two parts: a plugin that persists every submission to a WP table regardless of push outcome, **and** a signed read endpoint Ops polls to reconcile. **Do not ship part 1 alone.**

### 3.9 Additional Charges

An internal uplift on the quote — amount plus a short reason (`commercial access`, `stairs`, `specialist handling`) visible only to office and estimator. Needed from day one for the commercial work Pitmans brings.

`lib/quote/line-items.ts:customerLineItems()` already collapses the fleet base lines and admin fee into a single **"Your Removal"** line with no van count or crew size named, while preserving the invariant that **line items sum exactly to the subtotal**. The uplift folds into that collapsed line — no new concept.

**Constraint:** the uplift must be *inside* the collapsed line, not a separate hidden addend, or the PDF's own sum invariant breaks. Discount stays visible (it's good news); the uplift never appears on anything the customer sees. It counts as revenue in `lib/margin.ts`, and flows into the 25% commitment maths naturally because the commitment is computed from gross.

### 3.10 Payment policy

**Two policies, shared by all brands.** (2026-08-25 pm — **Peter reinstated the £100 deposit**, reversing the same-day retirement decision. Residential = today's live ladder for BOTH brands, plus three additive rules.)

| Policy | Applies to | Schedule |
|---|---|---|
| `residential` | Any brand, residential | **Today's v2 ladder, unchanged**: £100 deposit at acceptance (office-overridable) → date confirmed by the existing signature step → 25% commitment minus deposit, due T-7 → balance invoice at T-7. Same emails, same chases, same `/q` flow |
| `commercial` | Any brand, commercial | No deposit, no commitment, **no customer chase**. Invoice raised **on job completion**, due on the client's terms |

**Marley residential behaviour is otherwise unchanged — that is the headline property of this design.** Pitmans adopts the identical ladder, so `classifyBooking`, the chase cron, the `/bookings` buckets, the dashboard tiles, `owedNow`, `requestedDeposit`'s existing ≤7-day collapse and the v2 refunds engine all serve Pitmans rows with **zero residential code changes**. Card at accept stays for Marley; Pitmans renders the bank-transfer rail only, via `brands.card_payments_enabled`. Everything below is additive.

**Addition 1 — small jobs take one payment** (Peter, 2026-08-25). When gross ≤ a **small-job threshold (default £300**, editable in Settings beside the deposit default**)**, the acceptance ask IS the full amount: `requestedDeposit()` gains the rule, the commitment clamps to zero, no balance remains, no further invoice ever raises. The ask is always capped at gross (a £100 default against an £80 job asks £80). The live terms already cover a variable ask — *"The deposit is £100 for most moves. If yours is different, the amount is shown on your quote and on the payment page"* — so **no terms change**. This kills the real case from 2026-08-24: a ~£120 job asked £100 at accept and then a £20 balance the next day; now it asks £120 once.

**Addition 2 — late bookings raise the balance in the same breath** (Peter, 2026-08-25). The existing ≤7-day collapse (`requestedDeposit` = max(deposit, 25% × gross) — Peter, 2026-08-05) stays exactly as it is. What changes: when the move is inside T-7 at acceptance, the **balance invoice raises at acceptance alongside the ask** instead of trailing from the T-7 cron a day later — the customer sees the whole picture in one comms moment, two invoices payable separately or together. When a booking is late AND ≤ £300, Addition 1 wins: one full ask, nothing else.

> **Built narrower than this paragraph, deliberately (gate 9b, 2026-08-28).** The early raise is
> conditional on the customer's own **contract signature**, so it fires on the `/q` acceptance and
> not on the office's "Mark won". The reason is that the T-7 cron's guard is
> `leads.date_confirmed_at` — *"a final invoice names a move date, so it must never be raised
> against a date nobody confirmed"* (Marks Davis MMR019, 2026-08-13) — and that stamp **cannot
> exist at acceptance**, because confirming the date requires the deposit to be paid first. An
> unconditional raise would therefore not run ahead of that guard, it would bypass it on every
> late booking, on the one path (office marks won) that produced the incident. The signature is
> the nearest evidence of the same kind available at acceptance: a typed name against the
> acknowledgment set, on a quote that names the move date. It is one rule run by both accept
> paths — *raise early when the customer has signed for this booking* — which happens to be a
> no-op for the office path today. `ensureCommitmentInvoice` already gates on a signature read
> for exactly this reason, so the shape is the house precedent, not a new idea. Rules and
> reasoning: `lib/payments/late-balance.ts`.

**Addition 3 — pay in full at the commitment step** (Peter, earlier this session). The commitment email and its `/q` payment state offer both figures: the 25% now, or settle in full. Opting full raises the T-7 balance invoice early alongside the commitment — two open invoices, individually matchable, **no new `match_kind`, no new suffix**. A single bank transfer covering both is exactly the case `#73`'s **whole-quote link** (match kind `full`, migration `0103`) now handles: offered to the office only when the transfer equals the recorded payments to the penny, picked by a human, never auto-matched. Ignoring the option changes nothing.

> **As built (gate 9c, 2026-08-28), with two corrections to the surrounding notes.**
> **(a) It needs no Resend push, and §11.7 trap 4's lane split assumed it would.** The hosted
> date-confirmation template renders the whole commitment step through a single
> `{{{COMMITMENT_BLOCK}}}` variable, so an offer added inside `commitmentBlockHtml` reaches the
> templated send and the in-repo fallback alike — nothing to PATCH, nothing to republish, and
> none of trap 4's overwrite risk. Locked by a test rather than left as an observation, because a
> future template rewrite that inlines the block would silently stop offering the choice to every
> templated customer while the fallback ones kept getting it.
> **(b) There is no card on this surface, and "as today" is why.** §4 says card renders for
> card-enabled brands "as it does on today's payment states"; today's commitment state has no
> card button at all — card is deposit-only, because the balance rail is deliberately BACS-only
> (fees are too high at these values, Peter 2026-07-09) and settling in full is mostly balance.
> So "as today" resolves to none, and adding one here would have quietly reversed a pricing
> decision nobody asked to revisit.
> **The gate is one function, `payInFullAvailable`** (`lib/payments/pay-in-full.ts`, pure and
> tested), consulted by the /q render, the server action AND the commitment email. An option the
> page offers and the server refuses is worse than no option; an email advertising a choice the
> page will not honour is the same defect one surface further out. A small job, a late booking and
> a deposit that already covers the 25% all fall out of it without being special-cased — none of
> them has a commitment invoice to attach the choice to.

**Office "Send payment link"** (Peter, 2026-08-25 — the one piece kept from the abandoned channel redesign). A new office action on the quote detail and `/bookings`: generates a tokenised card page for exactly one invoice (deposit, commitment, full or balance) and emails/texts it — for the customer who phones in unable to do a bank transfer. Behind the global card kill switch AND `brands.card_payments_enabled`; absent for Pitmans at launch. All other payment copy and channels stay exactly as today.

**Classification.** `clients.is_company` is repurposed as the residential/commercial marker. It currently only selects which display name to use, so it starts driving real behaviour — hence the pre-flight check below. The flag carries to the quote form when a client is selected, and **replaces `quoteRefKind()`'s property-size regex** as the source of the `R`/`C` ref prefix. That also fixes a latent bug: today an unusual property-size string picks the wrong prefix, and the prefix is what the bank feed reconciles against.

**Client terms.** `clients.payment_terms_days` — **30 by default**, 60 selectable, editable on the client form, meaningful for commercial clients only. Applies to **removals and storage invoices alike**.

**Resolution and snapshot.** Policy resolves from the client type (brand does not differentiate residential) and is **snapshotted onto the quote at acceptance**, so changing a client's type later never alters an in-flight booking's schedule. Existing quotes backfill to `residential`, which describes their current behaviour exactly — the backfill changes nothing.

> **Pre-flight check — required before the migration runs.** Count clients with `is_company = true` and any bookings against them. Peter's premise is that live data is all Marley residential, in which case this is a no-op. But repurposing the flag would otherwise move those clients to post-pay terms and stop chasing invoices already issued. **If the count is non-zero, list them for Peter before proceeding** rather than migrating.

**VAT presentation.** Commercial quotes and PDFs show **net, a VAT line, then gross**; residential keeps the single inclusive figure. **`quotes.grand_total` and `agreed_price` stay gross for every quote** — ex-VAT is display only, so bank matching, margin, deposit maths and invoicing keep reading one consistent number. Commercial invoices itemise VAT as its own line; `getVatTaxId()` already exists and Xero handles tax rates natively. Note QA-20260823-02 was a stale-totals bug in exactly this plumbing — treat totals changes with matching care.

**Commercial flow.** No accept action on `/q` — the customer receives the quote and PDF to review, and the **office marks it confirmed** from the quote detail *or* the commercial section of `/bookings`, writing an activity-log entry naming who confirmed and when. Optional **PO number** on the quote, printed on the invoice when present, never blocking confirmation. No signature is taken.

**Chase.** Commercial is excluded from the chase engine entirely. Residential keeps **every current chase** — deposit day-1/day-3, commitment, balance, and the pre-acceptance quote chases — identically for both brands. A small-job full ask that goes unpaid is chased by the existing deposit chase (it IS the deposit ask, just larger). **When any chase email fires it now annotates the follow-up** with that fact and date — new behaviour making chase activity visible in the follow-ups queue rather than only the comms log.

**Overdue commercial.** An invoice past its terms shows an overdue state on `/bookings` and `/payments` and raises an **internal ops alert**. Nothing goes to the customer. "No automated chase" means the customer isn't emailed, not that nobody notices — this codebase has been bitten three times by monitors that went quiet instead of alarming.

**Accepted risk:** the office-confirm route produces no customer-side artefact proving a commercial customer agreed. Recorded, not re-litigated.

---

## 4. Per-page specification

**Rules applying to every page below.** All brand UI is gated on `isMultiBrand()` — with one active brand nothing here renders and the page is byte-identical to today. The brand chip is a **20px filled monogram square** — brand-colour fill, white initial (`M` charcoal, `P` blue), full name in a tooltip — deliberately a square so it can never be confused with the pill-shaped status badges, and **hidden when the filter is set to a single brand**. Detail-page eyebrows have room, so there the chip renders as the monogram plus the short name. The filter is a **segmented `All / Marley / Pitmans`** control reading `listActiveBrands()`, defaulting to **All**, driven by a URL param so it survives refresh and is shareable. Where a page already has a search or filter bar the segmented control joins that row; where it doesn't, it sits in the `PageHeader`.

**Two cross-cutting cleanups** happen as each page is touched: hardcoded hex (`bg-[#C03838]` on the Leads "Add lead" button, `BOARD_STATUS_STYLE`'s literal palette) becomes tokens, and `components/page-header.tsx`'s existing `eyebrowAccessory` slot carries the page-level brand chip on every detail page — it already does this job for status pills, so no new component is needed there.

`lib/dashboard/compute.ts`'s `SOURCES` palette (coloured dot + label, used on Leads, Board, Clients and the dashboard) is the existing precedent the `<BrandChip>` should visually rhyme with.

### Leads

**`/leads`** — Board and Table modes. **Changes:** brand chip and filter. **Looks like:** in Board mode the chip sits on the card beside the source dot, under the customer name; the card's status-keyed top border is untouched. In Table mode a **Brand column is inserted between Customer and Move**. **Works:** the segmented control joins the existing row of search input, status select and sort select, left of the Board/Table toggle. The 8 preset filter chips are unaffected and compose with it.

**`/leads/new`** — **Changes:** a **required brand selector, no default**, since both phone lines ring the same office. **Looks like:** a segmented control at the top of the form, above the customer fields — the first thing chosen, because everything else inherits from it. **Works:** the form cannot submit until a brand is picked; validation message "Choose which brand this enquiry is for." With one active brand the field is hidden and the brand is set silently.

**`/leads/[id]`** — **Changes:** brand shown and editable pre-quote. **Looks like:** brand chip in the `eyebrowAccessory` slot beside `LeadStatusBadge`. **Works:** clicking it opens a small change-brand control, available only while no quote reference has been issued; once issued it renders as a static chip with a tooltip explaining the ref prefix is fixed. Admin override writes to `events_log`. The AI-survey promo card's `mm-red` styling becomes brand-token driven so a Pitmans lead shows a blue card.

### Quotes

**`/quotes`** — **Changes:** brand chip and filter; the 4 summary tiles respect the filter. **Looks like:** chip sits between the customer name and the route line, on the same row as the ref. **Works:** segmented control joins the search row; the 5 preset chips (All/Draft/Awaiting reply/Accepted/Lost) compose with it. Tiles recompute for the filtered brand so "Win rate" means that brand's win rate.

**`/quotes/[id]`** — **Changes:** brand chip; **Additional Charges field**. **Looks like:** chip in `eyebrowAccessory` beside `QuoteStatusPill` and the meta chips. In the builder, an "Additional charges" amount and reason sit directly beneath the existing Discount box, visually grouped with it and labelled **"Internal — not shown to the customer."** **Works:** the amount folds into `customerLineItems()`'s collapsed "Your Removal" line; the reason is stored on the quote and rendered on the internal view only. The read-only `QuoteView` shows both to office and estimator, never on the PDF or `/q`.

**`/quotes/new`** — **Changes:** inherits brand from the lead when `?leadId=` is present; otherwise the reused `AddLeadForm` carries the same required brand selector as `/leads/new`.

### Pipeline and jobs

**`/board`** (Pipeline Board) — **Changes:** brand chip and filter. **Looks like:** chip on each kanban card beside the source dot. Column structure unchanged. **Works:** segmented control joins the existing search / source select / week select / Mine row. Note this page's heavy `mm-red` usage on active toggles and the dashed drag-target border stays Marley red — it's app chrome, not record branding.

**`/jobs`** (Completed Jobs) — **Changes:** brand chip and filter. **Looks like:** chip in the customer column beneath the quote ref. This page is already fully semantic with no `mm-red`, so nothing else changes. **Works:** segmented control joins the existing search form.

**`/bookings`** — **Changes:** brand chip and filter; **imported marker**. **Looks like:** chip beside the customer name, in the same position as the existing "Legacy (iMVE)" pill — imported Pitmans bookings get an equivalent **"Imported"** pill there until the job completes. **Works:** the page has no search bar today, so the segmented control goes in the `PageHeader`. All 8 money-lifecycle sections and their count pills respect it. The `AllocateChip` and danger section headers are semantic and unchanged.

### Customers and workflow

**`/clients`** — **Changes:** no brand column on the record; instead show **which brands this client has dealt with**. **Looks like:** in List mode a **Brands column between Client and Phone**, rendering one chip per brand the client has leads under — usually one, occasionally two. In Grid mode, chips under the name beside the `OriginBadge`. **Works:** derived from the client's leads, not stored. The filter shows clients having at least one lead in the selected brand.

**`/clients/[id]`** — **Changes:** brand chips on the Enquiries and Quotes lists. **Looks like:** chip beside each row's `LeadStatusBadge`. **Works:** read-only; a client is never assigned a brand.

**`/follow-ups`** — **Changes:** brand chip and filter. **Looks like:** chip on each card beside the reason-tone chip. **Works:** this page has **no search or filter bar today**, so the segmented control is added to the `PageHeader` — the first filter this page has had. The three sections (Overdue / Due today / Upcoming) and their tones are unchanged.

**`/documents`** — **Changes:** brand chip and filter. **Looks like:** chip beside `DocumentKindPill`. **Works:** segmented control joins the existing GET search form; composes with the three tabs. Contractor agreements are `group` and show no brand chip.

**`/claims`** and **`/claims/[id]`** — **Changes:** brand chip and filter. **Looks like:** on the list, chip after the claim ref and before `ClaimStatusPill`; on detail, in `eyebrowAccessory`. **Works:** no search bar exists, so the segmented control goes in the `PageHeader`, composing with the Open/Closed/All tabs.

**`/content`** — **Changes:** brand chip and filter. **Looks like:** chip on each media row beside the job link. **Works:** segmented control in the `PageHeader`, composing with the four review tabs. Matters because captured media feeds marketing, which is brand-specific.

### Money

**`/payments`** — **Changes:** brand chip and filter. **Looks like:** chip in the customer column of the Received tab. **Works:** segmented control joins the Received tab's search row and the `PageHeader` for Due/Upcoming. The `METHOD_CHIP` map has **Card = `bg-mm-red/10 text-mm-red`** — that is method colour, not brand, and is left alone to avoid implying a Marley payment. The `ExceptionsStrip` is business-wide and unfiltered by design: unexplained money is unexplained regardless of brand.

**`/refunds`** — **Changes:** brand chip and filter. **Looks like:** chip on each queue row beside the customer name. **Works:** segmented control in the `PageHeader`; the three sections and stat tiles respect it.

**`/finance`** — **Changes:** brand filter; reads through the ledger adapter; Zoho history from the snapshot table. **Looks like:** chip on each `InvoiceRow`; the five stat tiles recompute per brand. **Works:** segmented control joins the day-navigator header. Invoices carry brand via the quote reference prefix, so attribution works for both live and snapshotted history.

**`/finance/statements`** (Contractor pay) — **Changes:** **none structurally — this is a `group` surface.** Crew work both brands, so a statement is per-person, not per-brand. **Looks like:** no brand chip, no filter. **Works:** unchanged. Per-brand crew cost is not needed for margin because `lib/margin.ts` computes cost from the `business_settings` rate card, which the brand filter already handles on `/performance`.

### Estimator

**`/estimator`** — **Changes:** brand chips on the day's appointments, follow-ups, sent quotes and assigned leads. **Looks like:** chip beside each item's existing meta. **Works:** no filter — this is one person's day and they work both brands; splitting it would hide work.

**`/estimator/pay`** — **Changes:** none. **`group` surface**, same reasoning as contractor pay.

### Resources and scheduling

**`/resources`** — **Changes:** a **livery brand on vehicles only**. Staff and availability are unchanged: crew are shared and carry no brand. **Looks like:** on the Vehicles tab, a brand chip on each vehicle card and a brand selector on the vehicle form with an explicit **"Unbranded / shared"** option as the default. **Works:** livery is informational. It drives the soft warning at allocation and nothing else — it never restricts which van can take which job, because the fleet is one pool.

**`/schedule`** (Availability + Day Allocation) — **Changes:** brand chips on job cards in Day Allocation; filter; **livery mismatch warning**. **Looks like:** the embedded `JobBoardView` colour-codes cards by *type* today (removal `border-l-mm-red`, survey dashed teal, pack amber) — that stays, with the brand chip added to each card. This board is where two brands' jobs visually collide today, so the chip matters most here. **Works:** segmented control on the Day Allocation tab. **The Availability month grid keeps green/amber/red capacity semantics and is never brand-filtered** — crew and vans are one pool, so per-brand capacity would show headroom another brand's job has already taken. When a van whose livery brand differs from the job's brand is assigned, a quiet inline note appears on the card: informational, never blocking.

**`/schedule/removals`** and **`/schedule/surveys`** — **Changes:** the diary colour model, plus a filter. **Looks like:**

| | Removal | Survey / Pack |
|---|---|---|
| **Marley** | Charcoal `#1A1A1A`, white text | Red `#C03838`, white text |
| **Pitmans** | **Blue**, white text | **Yellow**, blue text |

`scheduler-view.tsx`'s two-constant `SURVEY_STYLE` / `REMOVAL_STYLE` pair becomes a `brand × appt_type` lookup resolved from the brand's tokens. The brand initial (`M` / `P`) is appended to the event meta line as a second signal that doesn't depend on colour vision — charcoal-vs-blue is the pair most worth backing up. **No left bar** — the fill already carries the brand. **Works:** segmented control joins the "Show surveys" toggle row on `/schedule/removals`. The legend gains a row per active brand. The `<style jsx>` block pinning FullCalendar's now-indicator and today-ring to `var(--color-mm-red)` stays Marley red — that's app chrome, not a record.

**Unconfirmed days render hollow (2026-08-25).** A removal whose date is not yet confirmed (`date_confirmed_at` null — the customer hasn't signed the date-confirm card) draws as a **dashed outline in the brand colour with brand-colour text on a transparent fill**, turning solid the moment confirmation lands. The office plans from this surface, so confirmed vs pencilled must be visible at week zoom without opening the booking. Applies to both brands (charcoal dashed / blue dashed), ships with this gate, and is **not** gated on `isMultiBrand()` — Marley gets it too. Surveys and packs have no confirmation concept and always render solid.

**`/storage`** — **Changes:** brand on sites and lets; brand chip and filter. **Looks like:** chip on each site card and each let row; the unit occupancy tiles keep `bg-mm-red` occupied / `bg-success-bg` free, since occupancy is a physical fact not a brand one. **Works:** the let-assignment dialog takes brand from the selected client's originating lead, showing it as a pre-filled but overridable chip. Segmented control joins the existing "Search units or clients" row. Blandford is added as a Pitmans site if the depot stays.

### Admin and reporting

**`/settings`** — **Changes:** a new **Brands card**. **Looks like:** one row per brand showing name, colours, contact details, ref prefix and whether card payments are enabled; the group row is shown and marked as internal-only. **Works:** admin can edit **safe display fields** — phone, address, review URL, terms URL, colours, logo URL, card-payments toggle. Structural fields (slug, ref prefix, active) are read-only and change by migration, because a changed ref prefix would break bank reconciliation on refs already issued. Everything else on this page — pricing grid, VAT, base location, storage rates, AI caps — stays singleton, since pricing is identical across brands.

**`/performance`** — **Changes:** brand filter across all three tabs. **Looks like:** the segmented control joins the `TabBar` row. Estimator and Job margin tables gain a brand column; the Sales tab's existing "Source" breakdown table is the precedent for a later by-brand table. **Works:** an optional `brand` argument threads through `lib/sales-report.ts`, `lib/storage-report.ts`, `lib/estimator.ts` and `lib/margin.ts`. All aggregation is plain TypeScript over table reads — no SQL views, no reporting RPCs — so this is a parameter, not a query rewrite.

**Dashboard home** — **Changes:** per-brand figures on the KPI tiles. **Looks like (2026-08-25):** each tile keeps its **one combined headline number** — the business truth, since cash, crew and the bank account are shared — with a quiet `M 14 · P 6` sub-line directly beneath, using the monogram squares at 16px. With one active brand the sub-line doesn't render and the tile is byte-identical to today. "Where leads came from", the enquiry→job funnel and the estimator table gain the segmented filter. **Works:** cheapest of the layouts considered, keeps today's grid, and the sub-line delivers the acquisition-judging view. The Fleet-docs-due and Unsigned-contracts action cards stay combined: they're operational, and splitting them would risk one brand's overdue MOT being overlooked.

**`/automations`** — **Changes:** none. Cron and operational-issue log, brand-independent.

**`/manual`** — **Changes:** a dual-brand section per role, **built last**. **`group` surface** — charcoal, no brand colour. Covers how to tell which brand a job is, which brand a customer belongs to, that vans and crew are shared, and why the group mark exists.

### Crew surfaces

**`/my-jobs`** and **`/my-jobs/[id]`** — **Changes:** brand chip on job cards. **Looks like:** the card keeps its existing left border for job type (crew already know that colour); the filled brand chip sits beside the Move/Packing/Survey pill. The header keeps `<BrandMark>` — group chrome. **Works:** no filter; crew see their own day across both brands. **This is the surface where brand confusion costs most** — a crew member needs to know whose customer they're meeting and which livery to expect.

### Public token pages

All five hardcode logo, company name and number, phone, terms URL and `mm-red` classes. Each resolves its brand from its token and takes the **full palette**. The scale is real: `01747 637070` appears **nine times in `/q/[token]` alone**, across the not-found, declined, cancelled, expired, failed-card, error-card, balance-card and footer states — every one must resolve from the brand.

**`/q/[token]`** (accept and pay) — brand from the quote. Logo, `metadata.title`, headings, buttons, radio accents, focus rings, `TERMS_URL` and the footer legal line all brand-resolved. **The group mark appears twice: under the logo, and in the bank-transfer block beside the MarleyMoves Ltd account name** — the explanation belongs where the surprise happens, not in a footer. `BANK_DETAILS` stays a single shared account, correctly, and the copy explains it. The accept and payment states keep **today's behaviour** — deposit ask at accept, card offered where enabled. **Card is hidden for Pitmans** via `brands.card_payments_enabled`, so on every Pitmans state the bank-transfer and phone rails must read as the primary path, not a fallback, and the word "card" appears nowhere. The same switch governs whether the office "Send payment link" action exists for the brand. `"Call Connor on 01747 637070"` becomes brand-resolved — a named person and number that must not appear on a Pitmans page.

**`/s/[token]`** (storage agreement) — brand from the storage let. Logo, eyebrow, unit-summary callout, checkbox accents, submit button, phone (×3) and footer all brand-resolved. The `"This agreement is with MarleyMoves Ltd (Company No. 15914266)"` line stays factually correct for both and gains the trading-name clause for Pitmans.

**`/cv/[token]`** (customer cubic survey) — brand from the lead. Logo, heading font colour, phone (×2) and footer resolved. `CubicBuilder` is shared with the office quote builder and carries 14 tokenised `mm-red` usages — these must become brand tokens without changing the office-side appearance for Marley.

**`/sheet/[token]`** (crew day sheet) — **`group`**, charcoal. A crew day legitimately spans brands, so the sheet itself is neutral and **each job block carries its brand chip**. The extensive `text-mm-red` labelling (Moving from/to, postcode, Vehicle, Crew, Packing, Inventory, Notes, Photos) becomes the neutral group token. The per-job sheet PDF stays fully brand-specific.

**`/join/[token]`** (crew sign-up) — **`group`**. Recruiting for one shared crew, so `"Join the Marley Moves crew"`, the eyebrow, and `"Your details go straight to the Marley Moves office"` become group-worded. Charcoal, no brand colour.

**PWA manifest and app chrome** (`app/layout.tsx`, `app/manifest.ts`, `BrandMark`) — **unchanged.** Marley Ops stays the group's internal panel name, including for a Pitmans crew member installing the PWA. Brand belongs on the records, not the frame.

### Payment-policy changes by page

Separate from the brand layer, and **not** gated on `isMultiBrand()` — the commercial path and the residential additions apply to Marley today.

**Residential additions across pages (gate 9):** `/q` acceptance is **unchanged** — signature plus the deposit ask exactly as today, except the ask amount now reflects the small-job and late-booking rules (the payment block already renders whatever amount is asked, and the terms already say the amount is shown on the payment page). The **commitment payment state** on `/q` adopts the anatomy approved in the 2026-08-25 mock: **two selectable amount cards** — "Pay 25% now" (default-selected, balance amount and due date underneath) and "Settle in full" ("Nothing more to pay") — above a single bank-transfer block whose **Amount line follows the selection** while the reference never changes; the group-explanation line sits inside the bank block beside the MarleyMoves Ltd account name (Pitmans), and card renders for card-enabled brands as it does on today's payment states. Banner copy reads "Your date is confirmed — secure it with your 25% commitment", not the abandoned payment-confirms-the-day wording. `/bookings` keeps all 8 residential sections and the dashboard keeps its tiles — nothing retires. The quote detail and `/bookings` gain the office **"Send payment link"** action (card-enabled brands only).

**`/clients` form** (`add-client-dialog.tsx`, `edit-client-dialog.tsx`) — the existing **is-company toggle is relabelled Residential / Commercial** and now drives payment policy, not just the display name. A **payment terms** select (30 / 60 days, default 30) appears when Commercial is chosen. The list view shows a Commercial marker so the office can see who's on account terms.

**`/quotes/[id]`** — when the selected client is commercial: the builder shows **net, VAT line, gross** instead of one inclusive figure; an optional **PO number** field appears; a **"Confirm booking"** action replaces the payment-driven confirmation — residential days are confirmed by the 25% payment, commercial bookings by this office action. The Additional Charges box behaves identically for both. Residential is visually unchanged.

**`/bookings`** — two new sections, **"Commercial — awaiting completion"** and **"Commercial — invoiced, awaiting payment"**, alongside the existing residential sections (seven, after gate 9), which are otherwise untouched. Both hide when empty, like the current danger sections. Invoices past their terms render in the overdue tone. The **"Confirm booking"** action also lives here.

**`/payments`** — commercial invoices appear in Due and Upcoming keyed on their terms date rather than a move date. Overdue commercial raises an internal ops alert, never a customer email.

**`/follow-ups`** — follow-ups now carry a note when a chase email fired against them, and the date. New behaviour for both brands, making chase activity visible here rather than only in the comms log.

**`/q/[token]`** — for a commercial quote: the quote and terms render for review, with **no accept action, no payment block, no signature**. A line states the office will confirm and invoice on completion, payable on their agreed terms.

**`/storage`** — company storage clients get their agreed terms on storage invoices too. The billing cycle itself is unchanged.

**Job completion** — completing a commercial job raises its invoice through the ledger adapter with the due date set from the client's terms, alongside the existing completion certificate.

---

## 5. Build plan — 22 gates, one PR each

The number grew as scope became precise: 22, against roughly 20 working days before the 21 September data arrives. **This no longer fits comfortably.** Additional Charges, the Brands settings card and three payment-policy gates are the additions since the original sizing of 13. See §8 — the manuals gate and, if the books move late, the Xero adapter are the ones to defer.

Each gate: branch off `staging` → **apply the migration to staging first** (§11.1) → PR labelled `pitmans-gate` → four gates green on the PR → auto-deploy to staging → role agents both brands → report plus staging URL.

Migration before merge, not after: CI deploys the container without touching the database, and the health-check passes regardless because `/login` never reads the new columns.

### How gates merge (Peter's call)

Reuse `.github/workflows/qa-auto-merge.yml`'s machinery under a `pitmans-gate` label. It runs the full four-gate check **on the PR** (the other workflows only run on push), squash-merges on green, and explicitly dispatches the staging deploy — a `GITHUB_TOKEN` merge does not trigger push workflows, so without that dispatch the work never reaches staging or e2e.

Its **risky-path guard is not weakened, extended or bypassed.** Any PR touching `supabase/migrations/**`, `lib/payments/**`, `lib/comms/**` or `app/api/card/**` fails the auto-merge gate and sits for Peter, whatever label it carries. That guard exists because PR #28 auto-merged a migration under a `safe-fix` label on 2026-08-20; this build is not the reason to test it again.

In practice: **gates 3, 4, 11, 14, 15, 21 and 22 land without Peter** — list surfaces, diary, PDFs, terms, reporting, manuals. (Gate 15's merge is mechanical only because the terms *content* is approved by Peter in Drive before it is frozen — the auto-merge never publishes wording he hasn't seen.) The other ~15 touch schema, money or comms and queue for review, which Peter clears in batches. The build reports each queued gate with its staging URL and moves to the next **independent** gate rather than idling; it does not stack a dependent gate on an unreviewed one.

| # | Gate | Notes |
|---|---|---|
| **0** | Phase 0 prerequisites | External, parallel — see §7 |
| **1** | Brand foundation | `brands` (+`group`), brand columns + backfill, `lib/brand.ts` incl. `isMultiBrand()`, `brand_ref_counters`, `next_quote_ref(kind, brand)`, `deploy.yml` job-level filtering (§11.6), parity e2e project (§11.10). **No visible change** |
| **2** | Brands settings card | Editable safe display fields, so Peter can tune colours and details himself through the rest of the build |
| **3** | List surfaces A | `/leads`, `/quotes`, `/bookings`, `/jobs`, `/board` — chip + filter, hex→token cleanup. Proves the pattern on read-only screens |
| **4** | List surfaces B | `/clients`, `/follow-ups`, `/documents`, `/claims`, `/content`, `/payments`, `/refunds` |
| **5** | Lead creation | Required brand picker, pre-quote edit + lock, incomplete-lead badge |
| **6** | Quote brand + refs | Brand on quote, `PM`/`MM` issuance, quote list and detail |
| **7** | Additional Charges | Amount + internal reason, folded into `customerLineItems()` |
| **8** | Payment policy foundation | Resolver, `is_company` → residential/commercial, client terms field, ref-kind switch off the property-size regex, snapshot on acceptance. **Pre-flight check runs first and blocks on a non-zero count** |
| **9** | Residential additions | Ladder **unchanged** for both brands. Adds: small-job full ask (≤ £300 threshold in Settings, capped at gross); late-booking balance raised alongside the accept ask; 25%-or-full choice on the commitment email + `/q` state; office "Send payment link" action; follow-up chase annotation |
| **10** | Commercial path | Chase exclusion, confirm action on quote and `/bookings`, invoice on completion, PO number, net/VAT/gross presentation, overdue ops alert, storage terms |
| **11** | Diary | `/schedule`, `/schedule/removals`, `/schedule/surveys` — brand × type colour model, initial, legend, filters |
| **12** | Resources + storage | Vehicle livery brand, livery mismatch warning, storage site and let brand |
| **13** | Comms | `sender.ts`, `branded-shell.ts`, templates, Pitmans Resend set, reply domain, the two required disclosures |
| **14** | PDFs | Quote, contract, completion cert, job sheet branded; day sheet and contractor statement group; commercial net/VAT/gross layout |
| **15** | Terms | The one new version: unified brand-neutral document from Pitmans' wording, both brands rendering their own copy |
| **16** | Public token pages | `/q`, `/s`, `/cv`, `/sheet`, `/join`, per-brand payment copy (no card mention for Pitmans), commercial view-only `/q` |
| **17** | Ledger + Zoho | `lib/ledger/` extraction, Zoho adapter (**zero behaviour change**), history snapshot |
| **18** | Xero adapter | Xero implementation, branding themes per brand, VAT line on commercial invoices |
| **19** | Ingest | Per-brand secret, per-brand `external_lead_id` uniqueness, WP plugin, **pull rail**, watch both brands |
| **20** | Importers | Four CSV importers with dry-run |
| **21** | Reporting | Dashboard combined-headline + `M · P` sub-lines, brand filter on all three `/performance` tabs |
| **22** | Manuals | Dual-brand section per role — **last, and first to drop** |

**Read §11.7 before starting gates 6, 8, 10, 13, 17 or 20.** Each has a verified trap where the obvious implementation is wrong: the bank-feed matcher's hardcoded `MM` prefix, the `classifyBooking` deposit ladder, the `sender.ts` domain-recognition check, Resend's name-matched template PATCH, Xero's rotating refresh tokens, and the importer's dry-run contract. Gates **1 and 8 are foundation gates and run alone** — no other work in flight, following the `payments-policy-v2-prd.md` §7 precedent.

### The cutover calendar

**The single promotion to prod — work-bound, on Peter's word.** Ordered migration batch from `docs/pitmans-prod-migration-runbook.md`, then `notify pgrst`, then the production deploy. **The gate is validated work, not a calendar day** (Peter, 2026-08-28: *"once all work is validated and tested we are safe to merge — i will say when, but we are not restricted by a date but by the work we need to complete"*). Earlier than September is fine and expected if the gates land clean. Two calendar constraints survive, because they are facts about Mark's handover rather than about our readiness: promote on a **clear working day**, and **never inside the 21–28 September import week** — so a bad promotion is found while the paper diary is still the only Pitmans record. The brand UI stays off (Pitmans seeds `active = false`) and the residential ladder is unchanged — what does go live for Marley is the **additive payment set**: the small-job full ask, the late-booking simultaneous balance, the pay-in-full choice at commitment, and the payment-link action. Treat the first live Marley acceptance after promotion as a verification step, not a routine event.

**When the promoted build is verified — activate (Peter's call: "once the work is ready we can flip it to live before the import").** Flip the Pitmans brand row to `active = true` in production as soon as the promotion is verified — not pinned to a date, but **always before the prod import**. Activating early costs nothing: the brand UI turns on with zero Pitmans rows, and it buys two things — the office can hand-key Pitmans enquiries from the moment the transfer starts on the 21st (`/leads/new`'s brand picker only renders in multi-brand mode), and every imported row renders badged from its first second. Importing into a single-brand prod would put real Pitmans jobs on the live diary unbadged, in Marley colours.

**21–28 September — import and verify.** Import to staging first; Mark verifies forward bookings against the paper diary jointly with Peter; fix, re-import, then run the same importer against production with `--commit --prod`. Imported bookings land `chase_paused` (§11.8), so nothing is sent to a Pitmans customer by this step.

**28 September — full go-live.** WP plugin live on `pitmansremovals.co.uk`, Mark's admin account active, Pitmans comms rails on. The UI switch already happened days earlier; this day is about the outside world reaching the system, not the system changing.

---

## 6. Testing

**Extend the existing protocol, don't build a parallel one.** `qa/AUDIT.md` already defines four role agents — Crew, Admin, Estimator, Customer — each with an operation list, eight cross-role handoff scenarios, marker discipline (`QA-SENTINEL`), counted cleanup, a findings protocol splitting `safe-fix` from `risky`, spec growth into permanent Playwright specs, and a rota ledger. `e2e/` is already split `crew/ estimator/ office/ public/`.

Every proof already requires three-way confirmation: **own UI confirms → SQL read-back confirms → the role that should see it confirms in its own browser.**

### Additions

**1. Single-brand parity.** Before anything else, each gate asserts that with only Marley active **no brand UI renders at all** — no chip, no filter, no colour drift from the current build's own single-brand baseline. It protects the live system's brand surface through four weeks of building and runs on every gate. It is deliberately not an "app frozen in August" assertion: the payment additions alter behaviour on purpose and carry their own assertion set (§6.6).

**2. Brand dimension.** Every rota'd operation runs twice, once per brand.

**3. A new always-on lens: brand-correctness.** Alongside two-hats, IO-proof and truth-of-UI. For every customer-visible output, assert the right brand's logo, name, phone, terms link, colours, ref prefix, from-address and legal line — and that the group mark is present where required.

**4. Brand-leak scan.** Mechanical: no `Marley`, `marleymoves.co.uk`, `01747 637070`, `Connor` or `mm-red` on a Pitmans surface, and no Pitmans string on a Marley surface. Catches the whole class rather than one instance at a time — and given `01747 637070` appears nine times in `/q` alone, the class is what matters.

**5. New cross-brand handoffs**, added to the eight that exist:

- Admin creates a Pitmans lead → quote → `PMR` ref → customer `/q` shows Pitmans branding, accepts and pays the deposit by **bank transfer only** (no card option anywhere), with the group mark beside the MarleyMoves Ltd account name → crew `/my-jobs` shows a Pitmans chip.
- A crew day holding one Marley and one Pitmans job → day sheet is group-branded with correct per-job chips → each per-job sheet carries its own brand.
- Pitmans storage let → branded agreement at `/s` → branded invoice → bank feed matches the `PM` reference.
- Pitmans ingest secret rejects a Marley-branded payload; the same `external_lead_id` from both brands creates two leads, not one.
- A Pitmans-liveried van assigned to a Marley job raises the soft warning and does not block.

**6. Payment-policy scenarios.** These are `risky`-class by definition (money, comms sending) and never auto-fixed:

- **Marley residential is unchanged.** The strongest assertion in this project after single-brand parity, restored by the 2026-08-25 pm reversal: a standard Marley residential quote still takes the £100 deposit → date-confirm signature → 25% commitment at T-7 → balance, with the same chase schedule, the same `/q` flow (card included) and the same `/bookings` buckets. Runs on every payment gate.
- Small job (≤ £300): accept asks the **full amount once** — no commitment, no balance, no later invoice; unpaid, it chases on the deposit rails; £120 job → one £120 ask. Cap check: an £80 job asks £80. Threshold edit in Settings takes effect on new acceptances only.
- Late booking (inside T-7): accept asks max(£100, 25%) as today AND the balance invoice exists in the same comms moment — assert exactly one email carrying both, and nothing trailing from the T-7 cron the next day. Late AND ≤ £300 → the small-job rule wins.
- Pay-in-full at commitment: the state shows both amounts; opting in raises the balance early — two invoices, individually matchable; a single covering bank transfer surfaces as the **whole-quote link** (`#73`, exact pennies, office-picked) and **never auto-matches**; ignoring the option leaves the ladder untouched.
- Send payment link: produces a working card page for exactly one invoice, only on card-enabled brands — for Pitmans the action is absent and no Pitmans surface mentions card.
- Unified residential parity: a Pitmans residential quote and a Marley one produce identical schedules, chase timings and `/bookings` buckets — only branding and the card rail differ — and the bank feed matches `PMR###-DEP` / `-COM` / `-BAL` end-to-end.
- Commercial: `/q` renders view-only with no accept action, no payment block, no signature → office confirms from both the quote and `/bookings` → activity log names who and when → **no chase email is ever generated** (assert the `communications` table, not just the UI) → job completes → invoice raised with the due date from the client's terms.
- Commercial VAT: quote and PDF show net, VAT and gross; `grand_total` is still gross; the invoice itemises VAT.
- Commercial overdue: past terms raises an internal ops alert and **nothing reaches the customer**.
- Changing a client's type after acceptance does **not** alter an in-flight booking's schedule (the snapshot holds).

### How role agents run per gate

**Role agents run on every gate (Peter's call).** `qa/AUDIT.md` describes a scheduled 45-minute unattended audit with a rotating operation list — that is the wrong shape for a build gate, so gates use a **scoped variant of the same protocol**, not the rota:

- The build session dispatches one subagent per **affected** role, with an operation list scoped to what the gate actually changed, rather than the stalest items from `qa/state.json`. Under ultracode this dispatch is a Workflow stage (§12) — same rules, deterministic fan-out.
- Every hard safety rule in `qa/AUDIT.md` carries over unchanged — staging only, marker discipline (`QA-SENTINEL`), counted cleanup verified by query, `risky` findings never auto-fixed, no prod credentials.
- **Role agents still never run migrations.** Schema work they think is needed is a `risky` finding, per the existing rule. The build agent owns migrations; the QA agents own evidence.
- Findings file into `qa/findings/` under the existing protocol, so the repair loop and the scheduled audit both keep working through the build.
- The three-way proof stands: own UI confirms → SQL read-back confirms → the role that should see it confirms in its own browser.

Cost, stated honestly: this is ~22 audit cycles on a plan that already has no slack. It is the right call for money and comms gates and it is the reason gate 22 will almost certainly drop — see §8.

### Role-agent evidence discipline — non-negotiable

**This is now largely the house rule, not a proposal.** `#71` (`68439b5`) already raised role agents to `sonnet`, made a report count as evidence "only if it carries literal automation artifacts (the `page.url()` trail it visited, the SQL read-back it ran)", and added a main-loop spot-check of one claim per agent per run. What follows is why, plus the two extensions this build adds on top.

**The QA loop produced fabricated evidence twice in two days.** Not hypothetical, and running role agents on all 22 gates multiplies it:

- **2026-08-24T04:32Z** (`527ce38`): Haiku-tier role agents across all four roles "did not perform the live browser-driven UI testing AUDIT.md requires — they substituted direct service-role DB/storage writes or static code review **while narrating it as live UI evidence**." The same run left 7 orphaned throwaway auth accounts behind "despite both the admin and estimator reports explicitly claiming zero." No findings were taken from their claims.
- **2026-08-23** (`50b76c0`, corrected by `48e373c`): three findings were moved to `closed/` with byte-identical notes citing a run-log entry **that was never written**. One was closed on nothing and had to be reopened.

An unreliable pass is worse than no pass, because it consumes the wall-clock *and* removes the signal. Four rules therefore govern role agents during this build:

1. **Sonnet minimum — never Haiku.** Now in `qa/AUDIT.md`. Judgment, spec-writing and fix-writing stay in the main loop.
2. **A pass requires an artefact independent of the agent's prose** — a `page.url()` trail, the SQL read-back printed with its query, a `communications` row id, a PDF byte count. Now in `qa/AUDIT.md`.
3. **Cleanup is verified by the orchestrator, not self-reported** *(build extension)*. The build session runs its own `QA-SENTINEL` count across every touched table after each gate. An agent's claim of zero is an input to that check, never a substitute — self-reported cleanup was the claim that failed first. Delete children before parents and read the parent back: `#71` fixed exactly this in the h8 teardown, where `23503` was swallowed and every CI run leaked a marker set into staging.
4. **An agent that cannot perform the live check reports BLOCKED, not PASS** *(build extension)*. A check that cannot do its job must not report success — the rule both failures broke.

**One more thing to know going in:** the first-pass QA repair tier is **live again as of 2026-08-25** — it fixed QA-20260825-01/-02 unaided (`#79`/`#80`), though the human review (`#82`) found a real defect in each robot fix, so its output gets a human read before prod. During this build that creates an interplay to manage: **safe-fix findings raised against `pitmans-gate` work are the build agent's to fix in-gate** (§10), and the "build in progress" note in `qa/state.json` (§8) also tells the repair tier to leave findings on in-flight gate surfaces for the build session rather than racing it to a fix.

### Gate definition

A gate passes when CI is green on all four gates plus e2e; the staging migration has been applied and verified; the single-brand parity assertion holds; the affected role agents pass both brands with evidence; and the brand-leak scan is clean. Peter's approval works two ways, matching §5: the seven auto-merge gates report their staging URL and he reviews **post-merge** at his pace (revert is the remedy); the ~15 guarded gates wait for his review before merging.

`risky`-class findings (money, payments, RLS, comms sending, auth) remain Peter's call and are never auto-fixed.

---

## 7. Phase 0 — start immediately, no code

Long lead times, running in parallel with gates 1–9:

- **Resend domain verification** for `pitmansremovals.co.uk` — prerequisite for any Pitmans email
- **Reply domain DNS** — `reply.pitmansremovals.co.uk`, same job as the above
- **Pitmans brand assets** — Peter obtaining logo files and exact hex
- **Pitmans mailbox list** — `info@` is customer-facing today, not `hello@`. Confirm with Mark
- **WebEx SMS sender id** for Pitmans
- **WordPress admin access** — may run through 4B Design, who built the site
- **WP form stack discovery** — webhook config vs custom plugin
- **Pitmans terms document** — obtain from Mark, then author gate 15's unified brand-neutral version in Google Drive for redlining (§3.7); frozen to `legal/` and published with gate 15
- **Ask Mark how he plans part-load runs**
- **Xero migration** — Peter and the accountant, live before 28 September
- **Mark's Ops account**

Deliberately deferred: takepayments trading-name descriptor (card is off for Pitmans at launch, but lead times run to weeks, so worth starting).

---

## 8. Risks

**Xero has no fallback.** Peter has committed to Xero being live before 28 September and declined a checkpoint. If it slips, Pitmans launches with Marley-branded invoices, since in-house invoice PDFs are roughly two weeks of work that isn't being started. Stated, accepted — but it is the single largest schedule dependency here.

**There is no slack left, and the role-agent decision spent what little remained.** 22 gates against roughly 20 working days, up from the 13 the cadence was sized on, now with a scoped role-agent pass on every gate rather than only the money and comms ones. **Gate 22 (manuals) is the designated drop** — treat it as already dropped and be pleasantly surprised. Gate 18 (Xero adapter) is second if the books land late. If more than those two need to give, the honest move is to launch on the current ladder with **none of the gate-9 additions** (they are additive by design, so dropping them costs convenience, not correctness) — say so early rather than compressing the money gates.

**One promotion at the end concentrates deployment risk into a single day.** Peter's call. The brand layer is inert at promotion (Pitmans seeds `active = false`) and the residential ladder is unchanged — what the promotion does switch on for Marley is the additive payment set (small-job ask, late-booking balance, pay-in-full, payment link), with §6's assertions having held on staging for weeks by then. The residual risk is real — ~30 commits and ~10 migrations land together, and if the promotion goes wrong there is no bisect, only a revert. Three mitigations: promote on a **clear working day outside the 21–28 September import week**, whenever the work is validated and Peter calls it; keep `docs/pitmans-prod-migration-runbook.md` current from gate 1 rather than reconstructing it at the end; and run the full e2e suite against staging immediately before promoting, so the tree being promoted is the exact tree that was proven.

**Payment policy remains the highest-risk work, but the 2026-08-25 pm reversal shrank it dramatically.** The residential ladder is now untouched — gate 9 is additive (ask-amount rules, one extra invoice timing, a choice UI, an office action) and gate 10 (commercial) is the only genuinely new money path. Three mitigations stay non-negotiable: the pre-flight `is_company` count blocks the migration if it returns anything; "**Marley residential is unchanged**" is asserted on every payment gate; and every payment finding stays `risky`-class, never auto-fixed. The small-job and late-booking rules touch `requestedDeposit()` and the accept flow — mutation-test both against the existing `tests/lib/payments-policy.test.ts` suite.

**The nightly QA loop pushes to `staging` every night, throughout the build.** Two consequences, neither fatal but both certain:

- *Churn.* Four weeks of nightly commits land under 22 gate PRs. Conflicts will be in `qa/state.json`, `qa/LOG.md`, `e2e/COVERAGE.md` and `qa/findings/**` — annoying, never semantic. Rebase per gate; never resolve by dropping the loop's side.
- *False findings against half-built work.* Staging seeds Pitmans `active = true`, so the brand UI is live there from gate 1 and the scheduled audit will exercise a partially-built feature and file findings for gates that haven't happened yet. **Mitigation: each gate appends a one-line "build in progress" note to `qa/state.json` naming the gates landed so far.** The audit is explicitly told that unbuilt brand surfaces are expected, and that the standing contract is single-brand parity. Cheap, and it keeps the loop's real signal usable instead of drowning it.

**The QA loop's own reliability is a live risk, not a theoretical one.** Two fabricated-evidence incidents in the two days before this plan was written (§6). The four evidence rules in §6 exist because of them, and they are the mitigation — but if a third incident happens during the build, the correct response is to stop using role agents as a gate and fall back to e2e specs plus Peter's own eyes on the staging URL, not to keep accepting reports.

**The paper diary should stay a parallel record for two weeks after go-live.** It costs nothing and is the only fallback if the import is subtly wrong. The failure mode is a crew arriving at the wrong address on the wrong day, discovered by the customer.

**`sender.ts` is the riskiest file.** Gate 13 deserves a full read of every generated email, not a spot check — and the domain-recognition trap in §11.7 is the specific line to get right. `COMMS_DRYRUN=true` on staging means nothing sends, so `communications` rows are the evidence.

**Push-only ingest loses enquiries silently.** Gate 19 must ship the plugin and the pull rail together.

**Blandford is undecided.** Built as a per-brand base location and storage site either way. Their storage is physically at Blandford, so closing it means relocating every storage customer.

---

## 9. Open items

None blocking:

1. **Pitmans brand assets** — Peter obtaining; placeholder tokens until then
2. **Pitmans mailbox list** — pending Mark
3. **WordPress form stack** — RESOLVED (sampled live 2026-08-25): Contact Form 7 + wpcf7-redirect on the The7 theme (dt-the7 14.4.8). The gate-19 plugin hooks `wpcf7_before_send_mail`, with the CF7 form id as config
4. **Part-load scheduling** — pending Mark. Current expectation is one appointment per customer sharing a van across the run, which works today. Their **weekly recurring England & Wales run** has no recurring-appointment concept in Ops and would be created manually each week
5. **Blandford depot** — deferred, built either way
6. **Forward-bookings CSV shape** — template to Mark closer to 21 September
7. **`entry_channel` enum** — may want a `referenceline` value
8. **Man-and-van tier** — deferred to after cutover
9. **Long-distance overnights** — Scotland runs spanning days have no model for driver overnights or subsistence in crew pay. Out of scope; flag if Mark says it matters
10. **`scheduler-view.tsx` doc comment** — stale, describes surveys as an outline chip; correct it during gate 11

---

## 10. Implementation decisions

Pre-answered so the build doesn't stop. Where these conflict with something discovered in the code, the code wins — log it and continue.

**Identifiers.** Brand slugs `marley`, `pitmans`, `group`. Ref prefixes `MM`, `PM`, none for group. Initials `M`, `P`. Filter param `?brand=all|marley|pitmans`, absent means `all`. **Migrations continue from `0104`** — `0103` was taken by the whole-quote match kind (2026-08-25) and is already applied to staging and prod. Invoice suffixes stay `-DEP` / `-COM` / `-BAL`, all live for both brands — **no new suffix**: pay-in-full and the late-booking rule raise the standard `-BAL` early.

**Colours.** Sampled live from `pitmansremovals.co.uk` 2026-08-25 (computed styles, not theme guesswork): **primary blue `#2B2B76`** (submit buttons and headings — the dominant brand colour), **yellow `#FFCC00`** (the "Request Free Quote" CTA). A deeper navy `#170277` appears on some headings; `#2B2B76` is the UI primary. These are the migration seed values. Blue is the UI colour; yellow only for large flat areas — diary survey and pack blocks, and the email header band. Yellow blocks take blue text, blue blocks white.

**Stubs for blocked gates** — build the full code path, log a blocked-gate note, continue:
- **Mailboxes:** `info@pitmansremovals.co.uk` (confirmed live on their site) as `hello_from`; `accounts@pitmansremovals.co.uk` as `accounts_from`, flagged provisional.
- **Terms:** Marley's current text, marked provisional, until Pitmans' document arrives.
- **Xero:** adapter compiles and is unit-tested against fixtures; connect when credentials exist.
- **WP plugin:** build against the generic WordPress hook API so the form-plugin specifics are config, not code.
- **SMS sender, review URL, logo URL:** placeholders, flagged.

**Additional Charges storage.** New `quotes.additional_charges numeric(10,2) not null default 0` and `quotes.additional_charges_reason text`, mirrored into the breakdown JSON so the PDF renders from one payload. Folded inside `customerLineItems()`'s collapsed line, with a unit test asserting the sum invariant still holds.

**Environment seeding.** Staging seeds Pitmans `active = true`; production seeds `active = false`. The e2e seed gains a Pitmans brand, a commercial client on 30-day terms, a Pitmans residential quote and a commercial quote.

**e2e fixtures.** `e2e/fixtures/routes.ts`'s access matrix gains a brand dimension; `COVERAGE.md` updates in the same commit as each new spec.

**When a gate fails.** Diagnose and retry once. If it fails twice for the same reason, log a blocked-gate note, move to the next independent gate, and report at the end rather than stopping — **except** `risky`-class failures touching money, payments, RLS, comms sending or auth, which stop and ask.

**Sanity pull rail** stamps `marley` explicitly. It is Marley's website only.

**Chase annotation** updates the existing follow-up for that lead where one exists, creating one only if none does, so the queue doesn't fill with duplicates.

**Brand-leak scan hits in existing Marley code** (a hardcoded `Connor`, a literal phone number) are findings to fix in the same gate, not separate tickets.

**Where the brand-leak scan lives.** `scripts/brand-leak-scan.mjs`, run as part of each gate and wired into `npm test` once gate 3 lands. Two halves: a source grep over brand-specific paths (`lib/comms/`, `lib/*-docdef.ts`, `app/q/`, `app/s/`, `app/cv/`) for the forbidden-string list, and a Playwright assertion over rendered Pitmans pages on staging. Source grep catches the class; the rendered check catches what the grep can't see through a token.

**Where the WordPress plugin lives.** `wordpress/pitmans-lead-bridge/` in this repo, versioned alongside the ingest code it talks to, shipped to the site as a zip. A separate repo would let the contract drift silently, which is the exact failure the pull rail exists to prevent.

**`source_system` for imported rows is `pitmans`**, mirroring `imve`. Imported bookings are `chase_paused` (§11.8).

**Migration numbering and application.** Continue from `0104` (see Identifiers — `0103` is taken and applied). Every gate that adds one applies it to staging with `scripts/apply-staging-migration.mjs --verify` **before** merging its PR, and appends it to `docs/pitmans-prod-migration-runbook.md` in the same commit. The runbook is the deliverable that makes the promotion a scripted operation rather than an act of memory — which matters more, not less, now the date is work-bound and could arrive early.

**Two invariants worth asserting in unit tests**, because both have already caused bugs here: `customerLineItems()` sums exactly to the subtotal, and `next_quote_ref` is collision-free under concurrent calls.

---

## 11. Build mechanics — verified against the repo

A dry run of the 22 gates surfaced the mechanical facts below, which the earlier draft didn't carry. Each one is something the build would have hit and stopped on.

### 11.1 Migrations are manual. CI never runs them.

`.github/workflows/staging.yml` builds a Docker image and restarts the container. It does **not** touch the database. Migrations are applied by hand, and the app deploys *before* they exist unless you sequence it deliberately.

**Staging — use the script, it already exists:**

```
node scripts/apply-staging-migration.mjs supabase/migrations/0104_brands.sql --verify "select slug, name, active from brands order by sort_order"
```

It connects via the session pooler, wraps the file in a transaction, rolls back on any error, and reads `MARLEY_STAGING_SUPABASE_DB_PASSWORD` from `credentials.env`. Always pass `--verify` with a query that proves the change landed — a committed transaction is not evidence the column is what you meant.

**Order per gate: apply the migration to staging FIRST, then merge the PR.** The reverse ships code that queries columns that don't exist, and the container health-check passes anyway because `/login` doesn't touch them.

**Production — not the build agent's job.** Prod migrations run over SSH against `supabase-db`, and `AGENTS.md` records that direct prod DB writes from the shell are classifier-blocked. Prod is also outside the staging-only rule every QA agent operates under. The build applies staging migrations and prepares prod ones; **Peter runs the prod batch.**

**After a prod migration, PostgREST must be told:**

```
notify pgrst, 'reload schema';
```

Self-hosted PostgREST caches the schema. Skip this and every new column is invisible to the API while the SQL is provably correct — a failure that looks like a code bug and isn't. Hosted staging reloads itself, so this trap only exists on the box where it costs most.

### 11.2 `database.types.ts` is hand-edited, not regenerated

`docs/crew-reliability-handoff.md` records the convention explicitly: the file was **hand-edited, additively** to add new tables, deliberately, because it is merge-sensitive and a full regenerate produces an unreviewable diff. Every migration gate hand-adds its types the same way. Do not run `supabase gen types` — it needs an access token that isn't wired, and it would rewrite 4,700 lines.

### 11.3 The gates command

`npm run lint && npm run typecheck && npm test && npm run build`

Note **`npm run typecheck`, not bare `tsc --noEmit`** — the script is `node scripts/build-legal.mjs --check && tsc --noEmit`, and the legal check is the half that catches a terms edit that never got compiled. CI's `test` job runs bare `tsc`, so a stale legal artifact passes CI and fails at Docker build time instead.

### 11.4 Legal documents are hash-locked and immutable

`legal/` holds published documents with SHA-256 body hashes in `legal/manifest.json`, compiled into `lib/legal/generated.ts` by `scripts/build-legal.mjs` (bundled, because `output: "standalone"` means loose files don't exist in production). **Published versions are immutable — changing terms means adding a file, never editing one.** After any legal change run `npm run legal:build` and commit the regenerated artifacts, or the gate fails.

**How §3.7's one new version lands under this store.** The gate 15 unified document is a normal new version of `customer-terms` with a **brand-neutral body**: it says "the Company", carries MarleyMoves Ltd's legal identity, and brand name, logo and contact details come from the rendering shell — one hash, one version, both brands, which is what "one document both brands render with their own branding" has to mean under an immutable store. Existing signatures are never affected — `0093_signature_terms_snapshot.sql` records what each customer actually signed — and until gate 15 lands, both brands sign the live `v2-2026-08-11` wording, which already matches the kept ladder (§3.7).

### 11.5 e2e seeding

CI provisions users with `scripts/create-e2e-users.mjs` and seeds with `scripts/seed-e2e.mjs`, both against the staging DB with the service role, before running Playwright against the deployed site. Brand fixtures go in `e2e/fixtures/seed-data.ts` and `scripts/seed-e2e.mjs`. `scripts/seed-e2e-fixtures.mjs` and the new `e2e/fixtures/db.ts` (2026-08-25) exist alongside them — read all four before adding rows.

### 11.6 Promotion: one promotion at the end (Peter's call)

Everything lands on prod in a single promotion rather than per gate. **`master == staging` today**, so this build is what opens the gap — it does not inherit one. Consequences, accepted:

- Prod ends up ~30 commits behind `staging` for four weeks, from a standing start of zero, and **changes once — at the promotion**. The brand UI stays off (Pitmans seeds `active = false`) and the residential ladder is unchanged; the promotion switches on the additive payment set and the commercial path for Marley. If Peter wants the small-job/late-booking fixes live sooner (they solve a real current annoyance), gates 8–9 can promote early as a standalone mini-promotion; the default is still one promotion, taken when the whole set is validated.
- **`deploy.yml` gets #55's job-level filtering shape in gate 1** (Peter's call). `AGENTS.md` records the trap: `deploy.yml` still filters at the *workflow* level, so a docs-only commit pushed to `master` produces no deploy run at all and prod silently drifts from `master`. It is tracked as [ClickUp 869entgjt](https://app.clickup.com/t/869entgjt) due 2026-08-30 — after the promotion this plan depends on. The fix is the one already proven on `staging.yml`, it is small, and it closes the ClickUp task early. Doing it in gate 1 rather than on promotion day keeps two risky things off the same date.
- All ~10 migrations apply to prod in one ordered session, followed by one `notify pgrst`.
- **Promote on a clear working day, never inside the import week.** The date itself is work-bound — validated gates plus Peter's word — but it must land before Mark's data arrives, so a bad promotion is found while the paper diary is still the only Pitmans record and no imported rows are in play. Promoting on the 21st stacks two risky operations on one day.
- Gate 1 must therefore produce, and every later migration gate must append to, an ordered `docs/pitmans-prod-migration-runbook.md`: the files in apply order, the `notify pgrst` step, and one verification query per migration. Peter executes it; the agent never does.

### 11.7 Code traps found in the dry run

Eight places where the obvious implementation is wrong.

**1. `classifyBooking` and `owedNow` need NO residential changes — resist inventing any** (`lib/bookings/queue.ts`). With both brands on the identical ladder, Pitmans rows flow through the existing buckets untouched, and a small-job full ask is just a larger deposit (paid → `commitmentAmount` clamps to 0 → `all_set` with no balance; unpaid → `deposit_outstanding` and chased — all existing behaviour). The one genuine gap is **commercial**: `classifyBooking`'s ladder and `owedNow`'s two obligations have no concept of a completion invoice due on client terms — that is gate 10's work, and widening `BookingBucket` there will surface exhaustive switches elsewhere; follow the compiler. Earlier drafts of this PRD deleted the deposit rung — that design is dead; do not resurrect any part of it.

**2. `lib/payments-policy.ts` already exists.** A pure, IO-free, fully unit-tested policy engine from Payments Policy v2 (`docs/payments-policy-v2-prd.md`, locked with Peter and Connor 21 July 2026), with `COMMITMENT_PCT`, `COMMITMENT_DUE_DAYS_BEFORE`, `CONFIRM_CALL_DAYS_BEFORE` and UK-wall-clock day maths. **The two-policy resolver belongs in that file**, tested in `tests/lib/payments-policy.test.ts`. Do not create a parallel module. Read that PRD before gate 8 — it also documents the "never say penalty" copy rule that any new payment email inherits.

**3. `lib/comms/sender.ts` recognises our own addresses by domain.** Line 51 tests `addr.endsWith("@" + MARLEY_EMAIL_DOMAIN)`, and line 105 builds `ours = [MARLEY_EMAIL_DOMAIN, "reply." + MARLEY_EMAIL_DOMAIN, "resend.dev", "amazonses.com"]`. These are inbound/reply classification, not outbound identity. **They must WIDEN to every active brand's domains, never swap to the current brand.** Threading `brand` through and substituting would silently stop Marley recognising its own reply addresses — the single most damaging one-line mistake available in this project.

**4. Resend templates are hosted, matched by NAME, and there are 28 of them.** `scripts/create-resend-templates.mjs` PATCHes by name and republishes, so **a Pitmans run with Marley's template names would overwrite all 20 live Marley templates.** Pitmans templates take a brand-prefixed name. Both brands run the same ladder, so the Pitmans set is a **full clone of Marley's** — deposit templates included — with brand copy, colours and the two required disclosures. The commitment template gains the 25%-or-full choice for both brands. `--preview-dir` renders to disk with no API key, so the whole Pitmans set can be built and eyeballed without touching Resend at all; do that before the first live push. Lane split between gates: **gate 9 edits only Marley's commitment template in place** (`--only`, adding the pay-in-full option); **gate 13 creates the Pitmans set**. No overlap.

Template **ids** currently resolve from 28 `RESEND_TEMPLATE_*` env vars. Add `templateIdFor(brand, key)` reading `brands.resend_template_ids`, falling back to the env var when the brand is Marley. Marley's live wiring then changes by exactly nothing.

**5. `next_quote_ref` carries security that must survive.** Migration 0038 gates it behind `is_office()`; 0037 makes it `SECURITY DEFINER`, revokes from `public, anon` and grants to `authenticated, service_role`. The two-arg version keeps all of it. Separately, `scripts/reset-data.mjs` deliberately does **not** reset the ref counters — `brand_ref_counters` needs the same exemption, or a go-live flush would reissue `PMR001` over a reference already sent to a customer.

**6. The bank-feed matcher hardcodes the Marley prefix.** `lib/bank-feed/match.ts:99` extracts refs with `/MM[RC]\d{3,}/gi` — a customer paying `PMR034-COM` by bank transfer would **never match** and sit in "Unmatched inbound" forever, which defeats the whole "per-brand attribution for free" claim in §3.3. Widen the pattern to the active prefixes (`(MM|PM)[RC]\d{3,}`, or built from `brands.ref_prefix`), and extend the O→0/l→1 typo normalisation (`match.ts:108`) to the new prefix — the Brydee Thomas "MMRO17" incident is why that normalisation exists, and Pitmans customers will make the same typos. Note `match_kind` is a closed set, now five values (`deposit | commitment | balance | storage | full` — migration `0103`, `sync.ts:226`); Pitmans needs no new kind, and the `full` whole-quote path (`lib/bank-feed/whole-quote.ts`) is amount-based so it serves `PM` quotes with no changes. **The regex widening lands in gate 6 with the `PM` ref issuance**, not gate 9 — the moment a `PMR` ref can be issued on staging, the matcher must be able to see it.

**7. Per-brand SMS sender already has an env convention.** `lib/comms/send.ts:221` reads `WEBEX_SMS_SENDER_MARLEY_MOVES || WEBEX_SMS_SENDER`. Gate 13 resolves the sender from `brands.sms_sender` with that env pair as the Marley fallback, so Marley's live wiring changes by nothing — the same fallback shape as `templateIdFor()` in trap 4.

**8. Xero refresh tokens rotate on every use.** Zoho's don't, which is why `lib/zoho.ts` reads `ZOHO_REFRESH_TOKEN` from the environment and caches only the access token in memory. Xero invalidates the old refresh token each time one is used, so **env-var storage cannot work** — a second container would race and lock the integration out. The Xero adapter needs a small persistent token row (encrypted at rest, single-writer with a row lock) plus a one-off authorisation script in the shape of `scripts/zoho-staging-token.mjs`. Design this at gate 17, not gate 18, so the adapter interface has somewhere to put it.

### 11.8 The importer already has a template

`scripts/import-imve.mjs` is the shape to clone for all four gate-20 importers: **dry-run by default**, `--commit` to write, an *additional* `--prod` flag, `--rollback <batch-id>`, batch tagging on every row, and a documented CSV column contract with required-field validation. It resolves clients by email/phone and creates lead → quote → appointment → activity note in one pass.

**Imported forward bookings are chase-paused (Peter's call).** They import with `chase_paused` and a `source_system` of `pitmans`, mirroring how migration 0088 hard-excludes `imve` rows from money automation. These customers were sold by Mark under his terms and have never heard from us; the first contact from the new owner will not be an automated payment demand. The office collects them manually, and `/bookings` shows them with the "Imported" pill until completion. New Pitmans bookings taken after go-live run the unified `residential` ladder normally.

### 11.9 House precedent for a build this size

`docs/payments-policy-v2-prd.md` §7 is how the last project of this scale was executed here: explicit **file-ownership lanes**, a named foundation phase that runs alone, and a list of shared files each builder may not touch outside its lane. §8 records "code-binding notes verified against master by a 4-scout pass" — line-accurate maps of the call sites, read by builders before they start. This PRD's gates are sequential rather than parallel so lanes matter less, but the convention holds: **gates 1 and 8 are foundation gates that run alone**, and `lib/supabase/database.types.ts` is the shared file most likely to conflict if anything ever does run in parallel.

### 11.10 Final decisions from the dry run

**Mark Pitman gets `admin`** (Peter's call). The `user_role` enum is only `admin | estimator | crew` — there is no read-only office role, and `admin` is the only value that can mark a payment received or confirm a booking. He ran the business for 30 years and answers Pitmans customers from day one; anything less makes him ask someone else to do routine work. Everything he does is attributed in `events_log`. Building a fourth role was rejected as a gate of its own on a plan with no slack.

**Staging keeps Pitmans `active = true`** (Peter's call), so every one of the 22 gate reviews shows the brand work directly when Peter opens the URL. That means staging is multi-brand and cannot assert single-brand parity in its default state, so:

> **Parity is asserted by a dedicated e2e project.** It deactivates Pitmans via the service role in `beforeAll`, runs the parity specs, and reactivates in `afterAll`. It runs **serially, never alongside brand specs**, because it mutates global state. Its teardown **throws** on failure rather than logging — leaving staging single-brand would make every later gate look broken, and `#71` is the standing lesson about teardowns that fail quietly. The `afterAll` also reads the row back to prove reactivation happened; a restore that changed nothing returns no error either.

Production seeds `active = false` regardless, so the two environments differ deliberately and that difference is itself something the parity project proves is safe.

**Card payments have two switches and both must be true.** `business_settings.card_payments_enabled` is the existing global kill switch (migration 0043, defaults false). `brands.card_payments_enabled` is new and per-brand. **Precedence: the office card channels (phone payment, "Send payment link") exist only when global AND brand are both true**, and the word "card" appears in customer copy only under the same condition. Getting this backwards either mentions card on a Pitmans surface or silently removes Marley's office card channels.

**Storage pricing needs no per-brand work.** Migration 0075 already snapshots `rate` and `rate_period` onto `storage_lets` at creation "so later rate-card edits never disturb a running let", and `billing_model` is per-let (`period` or `crate_daily`). Imported Pitmans lets therefore carry their own agreed prices with no rate-card change and no override mechanism to build. The singleton `business_settings.storage_rates` stays exactly as it is. What Mark still needs to supply is the billing model and rate per existing let — a Phase 0 question, not a code problem.

**Gate 11 must not undo `#72`.** `lib/schedule/slot-range.ts` is new: `slotMinTime`/`slotMaxTime` now derive from the events actually rendered, because pinning them at 07:00–20:00 hid out-of-hours bookings from the Week and Day views the office allocates from. The brand × type colour work touches the same component — leave the slot-range derivation alone, and keep its 8 mutation-verified tests green.

**The commitment due date already has its floor.** Payments Policy v2's late-booker grace (the Brydee Thomas handling) already governs a date confirmed inside T-7 — the commitment falls due immediately and the date-at-risk alarm waits its grace. Nothing new to build; assert the late-confirmation case still holds for both brands in `tests/lib/payments-policy.test.ts`.

**Where the two ask rules live.** Both are one function: `requestedDeposit()` (`lib/payments-policy.ts:132`) already takes `agreed`, `baseDeposit` and `movingDate` — Addition 1 extends it with the small-job branch (`agreed ≤ threshold → agreed`), the threshold arriving as a new parameter read from `business_settings` (mirroring how the £100 default flows in today), and every branch caps at `agreed`. Addition 2 lives in the accept flow, not the policy engine: when `commitmentDueImmediately()` is already true at acceptance, `accept-flow.ts` raises the balance invoice in the same pass as the deposit invoice. Mutation-test both against the existing suite — `requestedDeposit` is test-locked from the 2026-08-05 work.

**Pay-in-full mechanics (gate 9, at the commitment step).** Opting for full raises the T-7 balance invoice **early**, alongside the commitment — two open invoices, individually matchable, no new `match_kind` against the now-five-value closed set (`deposit | commitment | balance | storage | full` — migration `0103`). Card (for card-enabled brands) or an office-sent payment link settles both exactly; a single bank transfer covering both surfaces through `lib/bank-feed/whole-quote.ts` as the office-picked whole-quote choice — exact-pennies against the summed set, human tap, never auto-matched. A customer who ignores the option changes nothing: the commitment chases as today and the balance raises at T-7 as today.

**Date changes keep their v2 posture.** `app/actions/booking-change.ts` already recomputes the commitment due date on a move-date change; the only delta is that an early-raised, still-unpaid balance invoice (a pay-in-full opt-in or a late-booking raise) re-dates along with it.

**Cancellations run the v2 25% engine for both brands, unchanged** — including the deposit's refundable-until-date-confirmed rule. Held money stays capped at 25% of gross against the original date, refunded in full if it re-books, everything above the cap refunded automatically via `unconditional_amount` — so a small-job or pay-in-full customer who cancels gets at least 75% back with no human decision. **Reconcile at gate 15:** when Pitmans' terms document arrives, check its cancellation clause against this model; a conflict is a finding for Peter, not a silent adjustment in either direction.

**Commercial pre-completion changes are trivial by construction.** No invoice exists until completion, so date changes move only the appointment, and a cancellation before completion has no money to unwind. The only commercial refund path is post-completion, which is rare enough to be a human job through the existing refunds queue.

**Existing vehicles backfill `brand = null`** (unbranded/shared). Null livery never mismatches, so no warning fires anywhere until someone deliberately tags a van from `/resources` — the office tags the fleet at leisure, not the migration.

**The Zoho→Xero flip in prod is an env change, executed by Peter — but only after the promotion.** The adapter reads its choice from config, so the flip itself is edit `app.env` + restart container. The dependency chain is fixed though: the adapter code reaches prod **only via the single promotion**, so the earliest prod flip is promotion day, and Xero must be live before the 28th. Making the promotion work-bound *widens* that window rather than narrowing it — but it does not widen the accountant's, which is why the Xero migration stays a Phase 0 item rather than a September one. Staging flips first and runs Xero for at least one full gate before prod follows. The **Zoho history snapshot runs before the flip**, and again before the Zoho account lapses if those differ.

**Late-booking comms are ONE moment, not two.** When Addition 2 fires (move inside T-7 at acceptance), the customer meets the collapsed ask and the balance invoice together, with copy explaining the whole amount is due before the move — assert in §6 that nothing trails from the T-7 cron afterwards. The comms for a normal-notice booking are unchanged from today.

> **Where that one moment actually is (gate 9b, 2026-08-28).** This paragraph assumed an
> "acceptance email" that the online path does not send: a customer accepting at `/q` stays on
> the page and pays there, and their first email is the day-1 deposit chase. So the one moment is
> **the balance-invoice email plus the `/q` page**, and both were made to carry both figures: the
> email drops its "your deposit is already accounted for" line whenever the deposit is genuinely
> unpaid and states the deposit, the balance and the total; `/q`'s deposit state — previously the
> only screen in the ladder that could not see a raised balance — now names it too. Nothing new
> is sent at acceptance, so the count is one email, not two.

**Group comms keep Marley's from-address.** Crew invites, day sheets, contractor statements and join approvals are internal/crew surfaces sent by the operating company — they continue to send from `hello@marleymoves.co.uk` exactly as today. The `group` brand row needs no email domain and no Resend set; zero change is the correct amount of work.

---

## 12. Execution model — ultracode workflows (Peter, 2026-08-25)

Peter's call at approval: build end to end under **ultracode** — Workflow-orchestrated, stopping only for questions the PRD cannot answer. The opt-in stands for the whole build; record it here so it survives context compaction.

**The main session is the orchestrator and the only writer of record.** It alone owns: staging migrations (`apply-staging-migration.mjs --verify` before each merge), git (branch, commit by explicit path, PR, `pitmans-gate` label), the four-gate command, merge handling, `docs/pitmans-prod-migration-runbook.md`, and the `qa/` ledger files (single-writer, so the nightly loop's churn stays mergeable). Workflow agents never run migrations, never push, never touch prod — the same boundary role agents already have.

**One workflow per gate**, five stages, pipeline not barrier where items are independent:

1. **Build** — a builder agent per file-lane carrying the gate's §4 spec + §11.7 traps verbatim. Most gates are one lane; when two lanes must run concurrently they take worktree isolation. Builders inherit the session model — money code is never delegated down-tier.
2. **Gates** — the main loop runs `npm run lint && npm run typecheck && npm test && npm run build` on the assembled diff. One failure loops back to the builder with the output; a second follows §10's blocked-gate rule.
3. **Adversarial verify** *(gates 6–10, 13, 16–18 — money, comms, ledger)* — three high-effort skeptics per risky claim, each prompted to **refute** it against §6's assertion list, "Marley residential is unchanged" always first. A majority refute is a finding for the main loop, never a silent fix.
4. **Role-agent QA** — §6's scoped variant as stages: one **Sonnet** agent per affected role × brand against the staging URL, artifact-only evidence, BLOCKED-not-PASS, cleanup verified by an orchestrator `QA-SENTINEL` count, one claim spot-checked per agent.
5. **Leak scan + report** — `brand-leak-scan.mjs` plus the rendered-page check, then the gate report with staging URL.

**Parallelism between gates.** Gates 1 and 8 still run alone. Otherwise one merge lane, but while a guarded gate waits for Peter the *build* stage of the next independent gate proceeds in an isolated worktree — §5's "moves to the next independent gate", made concrete. Dependency spine: 1 → everything; 8 → 9, 10; 13 → 16; 17 → 18; 20 waits on 6 (refs) and 8 (policy snapshot).

**Stopping rules — the complete list.** The build stops for: (a) `risky`-class failures — money, payments, RLS, comms sending, auth (§10); (b) the pre-flight `is_company` count returning non-zero (§3.10); (c) a third fabricated-evidence incident (§6's fallback: role agents stop gating, e2e + Peter's eyes take over); (d) a genuine decision §2/§10 doesn't answer. It does **not** stop for: guarded-gate merges (report, batch for Peter, continue on independent gates), Phase-0 blockers (stub per §10), nightly-loop churn (rebase per §8), or a single flaky CI run (retry once per §10).
