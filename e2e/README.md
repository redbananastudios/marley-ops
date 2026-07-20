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

## Status

**Runnable now** (once staging + seed + test users exist):
- Crew journey (`journeys/crew.spec.ts`) — browse jobs, read the sheet, download the PDF.
- **P0 #7** offline completion queues + syncs, **P0 #8** double-submit is idempotent (`scenarios/p0.spec.ts`).
- Office dashboard + automations smoke (`journeys/office.spec.ts`).

**Outlined (`test.fixme`) — fill selectors/assertions against staging:**
- Customer + estimator journeys.
- **P0 #1–#6** (deposit/balance separation, refund credit-note + VAT reversal,
  forfeit, partial credit, VAT-quarter attribution, declined card) — each needs
  the **Zoho + takepayments sandboxes** and carries the exact rule to prove.

These are `fixme` on purpose: they were written from the code, not yet validated
against a running UI, so they don't ship as false green. Turn them on as you
confirm each against staging.

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
