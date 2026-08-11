# Legal documents: versioning, publication and evidence

**Status:** plan, awaiting go-ahead. Raised 2026-08-11 from Peter asking whether the signed contract is viewable on `/documents`.

---

## Why

Two problems, one urgent.

### 1. The published terms contradict what the app enforces (LIVE)

The customer T&Cs at `marleymoves.co.uk/terms-conditions` — the terms every accept page cites as governing — say:

> The deposit … is fully refundable if you cancel more than 48 hours before the move.
> Cancellation more than 48 hours before the move: your deposit is refunded in full.
> A booking is confirmed once we've received a signed acceptance and a **£100 deposit**.

The app, at date confirmation, asks the customer to tick:

> I understand my deposit is now **non-refundable** … if I later cancel or move this date **within 7 days** of the move and Marley Moves cannot re-book the day, amounts I've paid **up to 25% of my job price** may be retained.

Four conflicts: refundable vs not, 48 hours vs 7 days, £100 vs 25% of job value, and fixed £100 vs the variable deposits the app now issues (`depositLabel`, £300 late-booking).

The signed date-confirm tick is a genuine defence — the customer explicitly agreed. But it contradicts the terms the contract itself cites, and ambiguity in consumer terms is read against the drafter. The terms were last changed on **2026-06-16** (site commit `8d01497`, *"deposit = £100 fully refundable >48h"*), which is **before** Payments Policy v2 shipped. The contradiction was introduced by shipping the policy without updating the terms.

**Concretely exposed today:** the three customers who have confirmed a date — Pamela Noble (MMR039), Vanessa Taylor (MMR041), Brydee Thomas (MMR034) — agreed to the 25% tick while the governing published terms said their deposit was fully refundable up to 48 hours out.

### 2. We cannot prove what any customer agreed to

`signatures.terms_version` is a bare string. Worse, it does not correspond to anything: it reads `generic-v1-2026-07-10` while the document it points at is dated 16 June 2026. The terms text itself is hand-written JSX in the site repo and is edited in place, so a past version exists only in git history — recoverable today by luck, not by design.

The same gap applies to the acknowledgment wording. `signatures.acknowledgments` stores `{ inventory: true, … }` — **keys only**. Reword an ack and every historical signature silently points at the new wording.

And there is **no published storage-terms document at all**. Storage customers tick a lien clause permitting disposal or sale of their belongings after 60 days unpaid, with nothing published behind it. That is the weakest item in the whole set and the one with the most teeth.

### 3. No contract document exists

Completions generate and store a PDF. Signatures do not — the evidence is a rendered panel. Producing "the signed contract" for an insurer or a dispute means screenshotting a page.

---

## Decisions taken (Peter, 2026-08-11)

| Question | Decision |
|---|---|
| The live contradiction | **Rewrite the terms now, legal review after.** Publish corrected wording, then solicitor. |
| Where the text is authored | **Draft in Drive, freeze to the repo on approval.** Google Doc for solicitor redlining; the approved version becomes immutable markdown. |
| Scope of pass 1 | **Customer T&Cs + storage agreement terms.** Contractor agreement and privacy policy follow later. |
| The website | **Renders the published file**, so the site and app can never disagree again. |

---

## The model

The word "source of truth" was doing three jobs. Separating them is the whole design.

| Role | Home | Mutable? |
|---|---|---|
| **Authored** — drafting, solicitor redlining | Google Doc in `Companies\MarleyMoves Ltd\06 Contracts & Legal\` | Yes, freely |
| **Published** — the exact text the site + app render | `marley-ops/legal/<doc>/v<N>-<date>.md` | **No.** Never edited once published; a change is a new file. |
| **Evidence** — what *this* customer agreed to | Snapshot on the signature row + baked into the contract PDF | **No.** Append-only. |

A folder proves what we *intended* to publish. Only a snapshot proves what the customer was *served*. Today we have neither.

**Drive is not demoted** — it stays the human library and the review surface, which a repo cannot be (a solicitor cannot redline markdown, an accountant cannot browse git). It simply is not what the app reads.

### Published file format

`legal/customer-terms/v1-2026-06-16.md`

```yaml
---
id: customer-terms-v1-2026-06-16     # what goes in signatures.terms_version
document: customer-terms
version: 1
effective_from: 2026-06-16
effective_to: 2026-08-12              # written when superseded; null while current
supersedes: null
approved_by: Peter Farrell
approved_at: 2026-06-16
source: reconstructed from site repo commit 8d01497
summary: Deposit £100, fully refundable more than 48 hours before the move.
acknowledgments:                       # the tick wording, versioned WITH the terms
  - key: inventory
    label: The move details and inventory in my quote are complete and correct.
---
```

`legal/manifest.json` is **generated**, never hand-edited: each id → body SHA-256, path, effective dates, and which version is current. `TERMS_VERSION` as a hand-maintained constant is deleted; the app asks the manifest for the current version of a document. That constant is exactly what drifted.

---

## Phases

Each phase is independently shippable and leaves the system better than it found it.

### Phase 0 — Stop the contradiction (urgent, do first)

Nothing here depends on the rest of the plan.

1. Draft corrected customer T&Cs matching Payments Policy v2: variable deposit, the 25% commitment, the 7-day window, date-confirmation mechanics, re-booking refund, and the storage lien.
2. Peter reviews the wording.
3. Publish to the website; update the app's version identifier to match.

**Verify:** the published terms and `DATE_CONFIRM_ACKS` state the same window, the same percentage and the same refund trigger. Read both side by side.

**Deliverable:** no live contradiction on new bookings.

### Phase 1 — The versioning spine

1. `legal/` structure, frontmatter schema, generated manifest with body hashes.
2. **v1 reconstructed** from site commit `8d01497` — the exact text every one of the 13 existing signatures agreed to. This is provable, not approximate: the file did not change between 16 June and the first signature on 31 July.
3. **v2** = the Phase 0 corrected text.
4. Storage terms **v1** — written from scratch, because none exists.
5. `scripts/publish-legal.mjs`: freezes an approved document, stamps `effective_to` on its predecessor, regenerates the manifest, writes the PDF to Drive, updates the brain note.
6. `currentVersion(document)` replaces the constant.

**Verify:** unit tests that a published file's hash matches the manifest; that exactly one version per document is current; that `effective_from`/`effective_to` never overlap. A test that fails if any published file is edited in place.

### Phase 2 — Evidence capture

1. Migration: `signatures.terms_sha256`, `signatures.terms_snapshot` (the full body text — a few KB per row, and it makes the row self-sufficient rather than dependent on a file surviving six years), `signatures.acknowledgment_labels`.
2. Capture at **all five** signature write-sites — this is the part that must not be missed:
   - `lib/quote/accept-flow.ts:526` — contract, online accept
   - `lib/quote/accept-flow.ts:1665` — date confirmation
   - `app/actions/crew-signatures.ts:67` — contract, crew tablet in person
   - `app/s/[token]/actions.ts:62` — storage, customer link
   - `app/(dashboard)/storage/actions.ts:682` — storage, office
3. Backfill the 13 existing signatures to `customer-terms-v1-2026-06-16` with its text and hash.

**Verify:** sign on staging, confirm the stored hash matches the manifest. Re-run and confirm the backfill is idempotent. A test that a new signing path without capture fails the build (a shared helper all five call, not five copies).

### Phase 3 — The contract PDF

1. `buildContractDocDef` alongside the existing completion-certificate machinery (pdfmake, `job-docs` bucket through the media-store seam, so it lands in R2 like everything else).
2. Contents: quote summary, **the full terms text at the signed version**, the acknowledgments with their wording and tick state, the signature image or typed name, signer, channel, timestamp, IP, version id and hash.
3. Generate at signing; store at `contracts/{signatureId}.pdf`; email the customer their copy.
4. `/documents` **View** becomes a real download for contracts, matching completions.
5. Backfill PDFs for the 13 existing signatures against v1.

**Verify:** open a generated PDF and read the terms in it; confirm the hash printed matches the manifest; confirm the customer copy arrives.

### Phase 4 — Website renders the published file

`publish-legal.mjs` copies the current version into the site repo; the terms page renders that markdown. A hash check fails the build if the site's copy diverges from the ops manifest — so drift becomes a red build rather than a silent contradiction.

Deliberately a **file copy, not a fetch**. Having the site build call an ops API would put a live dependency in the release path, which is the failure class that took down a deploy this morning.

### Phase 5 — Solicitor review

The reviewed wording publishes as v3 **through the pipeline**, which proves the pipeline works end to end. Pairs with the outstanding legal review of the generic launch terms (ClickUp 869e35z42).

---

## Brain + Drive

**Drive** `06 Contracts & Legal/`:
```
Customer Terms/
  _WORKING DRAFT.gdoc          ← authored here, solicitor redlines here
  Published/
    v1-2026-06-16.pdf
    v2-2026-08-12.pdf
Storage Terms/
  …same shape
```

**Brain** `01_Projects/Marley Moves/Legal/`: a hub note per document holding the version table, what changed and why, effective dates, and links. Written by the publish script. Read-only mirror of the current text with a "generated — do not edit" header, so `/recall` can answer *"when did we change the cancellation clause"* without becoming a fourth copy that drifts.

---

## Risks and things only Peter or a solicitor can settle

- **New terms bind new bookings only.** Pamela Noble, Vanessa Taylor and Brydee Thomas confirmed dates under v1. The 25% is likely unenforceable against them. Commercial call: honour v1 for those three, or approach them to re-agree.
- **Onerous terms need prominence.** Under the Consumer Rights Act 2015 an unusual or onerous term must be brought sharply to the customer's attention. A 25% retention qualifies. It should be prominent at accept, not clause 3 of a page nobody opens — worth designing, not just wording.
- **The storage lien has no published document.** Customers have agreed to disposal of their belongings via a single tick. Highest-priority item for the solicitor.
- **Never delete a published version.** UK limitation for contract claims is six years, so evidence must survive at least six years past the end of each contract.
- The launch terms are still marked GENERIC pending review; Phase 0 corrects the contradiction but does not make them a lawyer's document.

---

## Not in this pass

Contractor agreement and privacy policy. Both need the same treatment — the contractor agreement is signed and gates crew invoicing, and its wording is still draft pending accountant review — but they are out of scope for pass 1 by decision.
