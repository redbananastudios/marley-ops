# Staging environment, two-branch CI/CD, and the e2e deploy gate

**Status:** design agreed with Peter 2026-07-31. Implementation gated on the staging Supabase
project (see *What Peter needs to do*). This is the spec + runbook.

## Why

`ops.marleymoves.co.uk` is live with real customers, real money (takepayments + Connor's Zoho),
and real email. Until now every change went **straight to prod**, validated only by unit gates
(lint/tsc/vitest/build) + review — never by exercising the real UI/flows against a running
environment first. This adds a **staging environment** to catch flow/migration regressions
off-prod, and turns the mature Playwright **e2e suite into a hard gate** on the way to prod.

## Architecture

```
 feature work ──► push ──► [staging branch] ──► CI: test → deploy STAGING → seed → e2e(vs staging URL)
                                                         │                              │
                                                         ▼                              ▼ (green = required check)
                                              staging.ops.marleymoves.co.uk      promote: staging ─► master
                                                                                        │
                                                                                        ▼
                                                            [master branch] ──► CI: test → deploy PROD
                                                                                   (manual approval: Peter)
                                                                                        ▼
                                                                              ops.marleymoves.co.uk
```

Two branches, each bound to one environment by CI:

| | `staging` branch | `master` branch |
|---|---|---|
| URL | `staging.ops.marleymoves.co.uk` | `ops.marleymoves.co.uk` |
| App container (OVH box) | `marley-ops-staging` @ `127.0.0.1:3001` | `marley-ops-app` @ `127.0.0.1:3000` |
| Database | **Supabase Cloud** (free project) | self-hosted Supabase on the box |
| Integrations | **SANDBOX only** (see below) | LIVE |
| Deploy trigger | push to `staging` | push to `master` |
| Gate | e2e runs here (the required check) | manual approval before prod deploy |

## Staging integrations — sandbox only (invariant)

Staging must be structurally incapable of touching real money, books, or customers:

| Concern | Prod | Staging |
|---|---|---|
| Card | takepayments LIVE 292748 | takepayments **SANDBOX 292749** |
| Books | Zoho org 20106952968 (Connor's real) | Zoho **staging org/token** (`scripts/zoho-staging-token.mjs`); until wired, Zoho specs skip |
| Email | Resend live (`COMMS_DRYRUN=false`) | `COMMS_DRYRUN=true` (nothing sends) |
| Website leads | Sanity sync on, floor `2026-07-30T00:00:00Z` | `SANITY_SYNC_DISABLED=true` (never pulls real enquiries) |
| Data | real | seed fixtures only (`seed-e2e.mjs`, sinks: `e2e@marleymoves.test`, `07700900000`) |

The e2e seed already **hard-refuses the prod Supabase host** and requires `SEED_REMOTE_CONFIRM=yes`
for any non-local target — staging is a different host, so it seeds; prod can never be seeded.

## The e2e gate (how "blocking" is enforced)

1. `staging.yml` runs the full Playwright suite against the **live staging deployment** after it
   deploys + seeds. The job is named **`e2e`**; its status attaches to the commit SHA.
2. `master` is **branch-protected to require the `e2e` status check**. Because `staging → master`
   is a fast-forward (same SHA), the green check from the staging run satisfies the requirement —
   a red e2e means the merge to prod is refused.
3. The prod `deploy` job runs under a GitHub **`production` environment with a required reviewer
   (Peter)**, so even a green, merged commit waits for a human click before it restarts prod.

Belt (automated e2e) **and** braces (human approval). Running e2e against the real staging
deployment also makes it a **migration dress-rehearsal** — a bad migration fails on staging, not
prod.

## CI/CD files

- **`.github/workflows/staging.yml`** (new) — `on: push: branches: [staging]`:
  - `test` (GitHub runner): `npm ci && npm run lint && npx tsc --noEmit && npm test`.
  - `deploy-staging` (self-hosted `[self-hosted, ovh]`): build image with staging build-args from
    `/opt/marley-ops-staging/app.env`, run `marley-ops-staging` on `127.0.0.1:3001`, health-check
    `/login`, auto-rollback (mirrors prod's deploy job, different container/port/env-file).
  - `e2e` (GitHub runner, `needs: deploy-staging`): `npx playwright install chromium`, run
    `create-e2e-users.mjs` + `seed-e2e.mjs` against staging (secrets), `E2E_BASE_URL=https://staging.ops.marleymoves.co.uk npm run e2e`, upload the HTML report artefact.
- **`.github/workflows/deploy.yml`** (existing prod) — add `environment: production` to the
  `deploy` job (activates the manual-approval gate). Otherwise unchanged.

Secrets (GitHub repo → Settings → Secrets): `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`,
`STAGING_SUPABASE_SERVICE_ROLE_KEY`, plus the sandbox creds for the money specs when wired.

## Box provisioning (M2)

- `/opt/marley-ops-staging/app.env` — the staging env (template below).
- Caddy: add a vhost `staging.ops.marleymoves.co.uk { reverse_proxy 127.0.0.1:3001 }` (auto-TLS).
- DNS (IONOS): `A staging.ops.marleymoves.co.uk → 51.195.253.165`.
- Both containers share the `rbs` docker network; staging is `-p 127.0.0.1:3001:3000`.

## Day-to-day promotion runbook

1. Do the work on a branch; merge/push to **`staging`**.
2. CI deploys staging + runs e2e. Watch `staging.ops.marleymoves.co.uk` and the e2e report.
3. Green + you're happy → **fast-forward `master` to `staging`** (`git checkout master && git merge --ff-only staging && git push`).
4. The prod pipeline runs and **waits for your approval** in the Actions UI. Approve → prod deploys, health-checked, auto-rollback.

Hotfix that can't wait for staging: push straight to `master` (approval still gates it) — but the
default path is staging-first.

## What Peter needs to do (unblocks M1)

1. **Create a free Supabase Cloud project** (name e.g. `marley-ops-staging`, region London/`eu-west-2`).
   Give me: **Project URL**, **anon/publishable key**, **service_role/secret key**, and the
   **database password** (or the connection string). *Or* drop a `SUPABASE_ACCESS_TOKEN` (personal
   access token) into `credentials.env` and I'll create it + push migrations myself.
2. Confirm the **takepayments SANDBOX** creds (292749, on i9) and whether to wire the **Zoho
   staging** org now or defer the money e2e specs.

Then I run M1–M4 end-to-end and hand you a green staging URL + a live e2e gate.

## Staging `app.env` template

```
# --- staging Supabase (Cloud free project) ---
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon>
SUPABASE_SERVICE_ROLE_KEY=<staging service_role>
# --- app ---
NEXT_PUBLIC_APP_URL=https://staging.ops.marleymoves.co.uk
# --- SANDBOX / off (no real money, books, or email) ---
COMMS_DRYRUN=true
SANITY_SYNC_DISABLED=true
TAKEPAYMENTS_TEST_MODE=true
TAKEPAYMENTS_MERCHANT_ID=292749
LEAD_SYNC_SINCE=2026-07-30T00:00:00Z
# Zoho staging (or leave unset → Zoho specs skip)
# ...carry the remaining non-secret app config from prod app.env, swapping any live key for its sandbox...
```
