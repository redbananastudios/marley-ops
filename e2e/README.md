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

## Status (validated against local dev, 2026-07-20)

**Green now** (run against i9 local dev — see "Running locally"):
- Crew journey — jobs list + honest last-updated stamp + version; job sheet
  (price-free) + PDF download.
- **P0 #7** offline completion queues + syncs, **P0 #8** double-submit idempotent.
- Office dashboard + automations smoke (asserts the crew-job-sheets cron shows).
- Estimator workspace — "My day", starts a quote (reaches `/quotes/new`).
- Customer accept page — `/q/<token>` renders the sent quote (total, deposit,
  accept form).

**Gated (skip until the sandbox exists), body ready to run when un-gated:**
- Customer *accept → deposit invoice* — raises a real Zoho invoice, so it's gated
  on a **staging Zoho org** (`ZOHO_ORG_ID` numeric, never the live org).

**Outlined (`test.fixme`) — write the bodies against the staging Zoho org:**
- **P0 #1–#5** money-path (deposit/balance separation, refund credit-note + VAT
  reversal, forfeit, partial credit, VAT-quarter). Each drives the office
  deposit/complete/refund flow and asserts `/finance`; develop against the
  staging Zoho org (they hit Zoho, so they can't be verified without it).
- **P0 #6** declined card + office payment-matching — also need the
  **takepayments sandbox**.

These stay `fixme` on purpose: they hit Zoho/takepayments, so they can't be
verified without the sandboxes and must not ship as false green.

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
npx playwright test                 # 10 pass, 8 skipped (Zoho/takepayments-gated)
npx playwright test --project=crew  # just the crew role
```

## Turning on the money-path tests

Once the **staging Zoho Invoice org** exists (a separate org under the same Zoho
account — the same OAuth app works, the org is chosen per call), point the E2E
app + seed at it and the gated tests un-skip:

1. In `.env.e2e`, set `ZOHO_ORG_ID=<staging-org-id>` (numeric).
2. Restart the dev server with that `ZOHO_ORG_ID` (not the dummy).
3. Mirror the VAT config in the staging org (20% output + FRS 10% + the
   registration date) so the VAT specs are meaningful.
4. The `customer accept → deposit invoice` test un-skips automatically; write the
   P0 #1–#5 bodies against it.
5. **P0 #6 + payment-matching** additionally need the takepayments sandbox creds.

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
