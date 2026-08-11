# HANDOFF — legal document versioning + evidence

Plan: `docs/legal-documents-versioning-plan.md`. Peter authorised implementation 2026-08-11.

**Hard constraints for this build**
- **NO customer emails.** Test sends go to `peter.farrell1@gmail.com` only.
- Test on staging. Prod is read-only verification plus explicit operational actions.
- Migrations: staging first, verify, then prod, and always before the code that needs them.

## Goal

Close two gaps: the published T&Cs contradict what the app enforces (deposit "fully refundable >48h, £100" vs the app's non-refundable / 7-day / up-to-25%), and we cannot prove what any customer was served (`terms_version` is a bare string that does not even match the document's date; ack wording is stored as keys only; no storage terms are published at all).

## Milestones

| # | Milestone | State | Verified by |
|---|---|---|---|
| 1 | Versioning spine — `legal/`, frontmatter, generated manifest with body hashes, `currentVersion()` | **done** | `legal:check` in the typecheck gate; proved it fails on a tampered body |
| 2 | `customer-terms` v1 reconstructed from site commit `8d01497` | **done** | file identical to the live page; 18 unit tests |
| 3 | `customer-terms` v2 drafted to match Payments Policy v2 | **done** | tests assert 25% / 7 days / re-book / no "penalty" / no 48-hour promise |
| 4 | `storage-terms` v1 written from scratch | **done** | tests assert the lien procedure and that we don't claim storage insurance |
| 5 | Evidence capture — migration + all 5 signing sites + backfill of 13 signatures | **done** | 0093 staging+prod; all 13 rows carry 3736 chars of text, 1 hash, ack wording |
| 6 | Contract PDF + `/documents` View becomes a real download | pending | |
| 7 | Website renders the published file + hash check | pending | |
| 8 | `publish-legal` script → Drive PDFs + brain hub note | pending | |

## Key facts already established (do not re-derive)

- Site terms last changed **2026-06-16**, commit `8d01497` (*"deposit = £100 fully refundable >48h"*). First signature was 31 July, so **all 13 existing signatures agreed to that one text** — v1 is exactly reconstructable, not approximate.
- Prod signatures: **10 contract + 3 date_confirm**. The 3 date confirmations are Pamela Noble MMR039, Vanessa Taylor MMR041, Brydee Thomas MMR034 — the customers exposed by the contradiction.
- **Five** signature write-sites, all needing capture:
  - `lib/quote/accept-flow.ts:526` — contract, online accept
  - `lib/quote/accept-flow.ts:1665` — date confirmation
  - `app/actions/crew-signatures.ts:67` — contract, crew tablet
  - `app/s/[token]/actions.ts:62` — storage, customer link
  - `app/(dashboard)/storage/actions.ts:682` — storage, office
- Site terms page is **hardcoded JSX** at `site/web/app/terms-conditions/page.tsx` (119 lines), not Sanity.
- No published storage-terms document exists anywhere.
- Ack wording lives in `lib/signatures.ts` (`CONTRACT_ACKS`, `STORAGE_ACKS`, `DATE_CONFIRM_ACKS`); `signatures.acknowledgments` stores keys only.

## Next action

Milestone 6 — the contract PDF.

Gates after milestones 1-5: lint 0 - tsc clean - vitest **1551** - build ok. Not yet committed to staging at the time of writing.
