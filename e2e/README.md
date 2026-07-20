# Marley Ops — End-to-end tests (PRD Phase B)

Playwright E2E against a **staging** deployment (never production). The app runs
on the OVH box, not Vercel, so "staging" is a separate deployment you stand up
(its own DB, a **Zoho Invoice sandbox org**, and **takepayments sandbox**
credentials) — there is no Vercel preview.

## What's here

```
e2e/
  fixtures/      auth setup (storageState per role), seed constants, sandbox
                 cards, artefact + signature helpers, prod safety gate
  journeys/      customer · estimator · crew · office
  scenarios/     p0.spec.ts — the 8 go-live P0s
  artefacts/     screenshots / emails / PDFs (gitignored) + review.mjs (LLM review)
scripts/seed-e2e.mjs   idempotent reset to the known state the specs assert
playwright.config.ts   env-agnostic (E2E_BASE_URL); chromium only
```

## Status (validated against local dev + staging Zoho, 2026-07-20)

Full suite: **12 passed, 6 skipped, 0 failed** (run twice back-to-back to prove
the seed wipe survives sign-off artifacts). ZOHO_ORG_ID pointed at the staging
org **Demo Removals** (20117092566) — a separate Zoho account that physically
cannot reach the live books.

**Green now:**
- Crew journey — jobs list + honest last-updated stamp + version; job sheet
  (price-free) + PDF download.
- **P0 #7** offline completion queues + syncs, **P0 #8** double-submit idempotent.
- Office dashboard + automations smoke (asserts the crew-job-sheets cron shows).
- Estimator workspace — "My day", starts a quote (reaches `/quotes/new`).
- Customer accept page — `/q/<token>` renders the sent quote AND *accept →
  deposit invoice*: the £100 **-DEP** invoice is raised **in staging** and
  asserted directly against the Zoho books (VAT-itemised, £100, never live).
- **P0 #1** — deposit + balance invoiced SEPARATELY: the office raises the
  **-BAL** balance invoice (£2,300 = agreed − deposit) and it's asserted in
  staging (VAT-itemised, distinct reference). With the -DEP proof above, that's
  the full invariant: two invoices per job, each VAT-itemised, never one net.

**Deliberately NOT automated E2E** (`test.fixme` with the accurate reason — see
`scenarios/p0-money.spec.ts`):
- **#2 refund / #4 partial credit** — refunds + credit notes are handled
  **manually in Zoho by design** (deferred 2026-07-09). The app raises a
  refund-decision task on cancel; there is no in-app flow to drive.
- **#3 forfeit** — a human decision; the unwind (cancel appts, void UNPAID
  invoices, raise the refund-decision task) is unit-tested, the keep/refund call
  is manual in Zoho.
- **#5 VAT-quarter attribution** — the maths lives in `lib/finance` and is
  unit-tested; an E2E can't set differing tax points (Zoho dates at creation, no
  UI backdating).
- **#6 declined card + payment-matching** — needs the **takepayments sandbox**
  (deferred until the merchant id lands).

## Running locally (works today, no staging needed)

The app runs on i9; local dev is the E2E target for everything that doesn't hit
Zoho/takepayments. `.env.e2e` (gitignored) holds only the overrides — it's
layered over `.env.local`, and critically pins `ZOHO_ORG_ID` to a dummy so a
stray Zoho call fails closed instead of touching the live books.

```
# 1. Provision the three role logins in local Supabase
node --env-file=.env.local --env-file=.env.e2e scripts/create-e2e-users.mjs

# 2. Start the app under test with Zoho pointed away from the live org
ZOHO_ORG_ID=E2E-STAGING-PENDING COMMS_DRYRUN=true npx next dev -H 0.0.0.0 -p 3016

# 3. Seed the known state
SEED_CONFIRM=yes node --env-file=.env.local --env-file=.env.e2e scripts/seed-e2e.mjs

# 4. Run (env comes from .env.e2e)
set -a; source .env.e2e; set +a
npx playwright test                 # 100 pass, 6 skipped (money fixmes; +2 more when staging Zoho is wired)
npx playwright test --project=crew  # just the crew role
```

**Re-run hygiene:** re-seed (step 3) before every full run. Several specs mutate
shared seeded state (P0 #7 completes a crew job; the crew contractor spec signs
the agreement), and the seed is the idempotent reset that restores the known
state — a re-run without re-seeding will fail those specs. The seed refuses any
non-local target (and hard-refuses the prod Supabase host); pass
`SEED_REMOTE_CONFIRM=yes` only for a deliberate staging seed.

## Turning on the money-path tests

The staging org (**Demo Removals**, `20117092566`) is a **separate Zoho account**
from Connor's live books — deliberate, so the staging credentials physically
can't reach live. The org is chosen per API call, but a refresh token only sees
orgs in the account it was issued for, so staging needs **its own token**.

1. **Mint the staging token** (once). Follow the browser prep in
   `scripts/zoho-staging-token.mjs` (create a Self Client under the demo@ login,
   generate a grant code), then:
   ```
   node scripts/zoho-staging-token.mjs --client-id <id> --client-secret <secret> \
     --code <grant> --org 20117092566 [--dc eu]
   ```
   It verifies the token sees Demo Removals and prints the `.env.e2e` block.
2. In `.env.e2e`, paste that block (all four `ZOHO_*` vars) and comment out the
   `ZOHO_ORG_ID=E2E-STAGING-PENDING` dummy. **All four must switch together** —
   only changing the org id leaves the live token in `.env.local` in play, which
   can't reach the staging org (it fails, safely, closed).
3. Mirror the VAT config in Demo Removals (20% output rate + FRS 10% +
   registration date 2026-06-01) so the VAT specs are meaningful.
4. Start the dev server with `.env.e2e` **sourced** so the staging `ZOHO_*`
   override `.env.local` (Next respects already-set `process.env` over `.env`
   files), then reseed:
   ```
   set -a; source .env.e2e; set +a
   COMMS_DRYRUN=true npx next dev -H 0.0.0.0 -p 3016
   SEED_CONFIRM=yes node --env-file=.env.local --env-file=.env.e2e scripts/seed-e2e.mjs
   ```
5. The `customer accept → deposit invoice` test un-skips automatically; write the
   P0 #1–#5 bodies against it.
6. **P0 #6 + payment-matching** additionally need the takepayments sandbox creds.

## Setup

1. **Env** (`.env.staging`, never committed):
   ```
   NEXT_PUBLIC_SUPABASE_URL=…            # staging Supabase
   SUPABASE_SERVICE_ROLE_KEY=…           # staging service key (seed only)
   E2E_BASE_URL=https://staging-host     # the staging app
   E2E_OFFICE_EMAIL/PASSWORD=…           # test users (see below)
   E2E_ESTIMATOR_EMAIL/PASSWORD=…
   E2E_CREW_EMAIL/PASSWORD=…
   E2E_SINK_EMAIL / E2E_SINK_PHONE       # where seeded customer comms go
   E2E_CARD_APPROVED / E2E_CARD_DECLINED # takepayments sandbox PANs (card P0s)
   ANTHROPIC_API_KEY=…                   # optional, for the artefact review
   ```
2. **Test users** — create `e2e-office@`, `e2e-estimator@`, `e2e-crew@` in
   staging auth (see `scripts/create-prod-users.mjs` for the pattern) with the
   right `profiles.role`. The seed links `e2e-crew@` to its staff row by email.
3. **Seed** the known state:
   ```
   SEED_CONFIRM=yes node --env-file=.env.staging scripts/seed-e2e.mjs
   ```
4. **Run**:
   ```
   npm run e2e              # all projects
   npm run e2e -- --project=crew
   npm run e2e:review       # advisory LLM pass over the captured artefacts
   ```

## Notes

- **No live card payments, ever.** The card scenarios use the takepayments
  sandbox only — a live test payment creates a real VAT tax point. `globalSetup`
  refuses to run against a production host.
- **Web-first assertions only** — no hardcoded waits; `expect` polls.
- **Artefacts**: `step()` captures a full-page screenshot per step; downloads +
  email HTML land under `e2e/artefacts/<test>/` and feed `review.mjs`.
- The browser is Chromium only (this repo's env has no webkit); the crew/customer
  projects use a phone viewport rather than a webkit device.
