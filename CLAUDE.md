@AGENTS.md

## Data policy until go-live (Peter, 2026-07-13)

**Production `ops.marleymoves.co.uk` holds MOCK/TEST data only until Peter approves testing complete.** No live-lead backfill, no real customer records, keep `SANITY_SYNC_DISABLED` in place. The `growth_artifacts` rows are exempt (agent proposals + tracking summaries — no customer data). Do not flip anything to live data without his explicit approval. **Dev mirrors this**: `SANITY_SYNC_DISABLED=true` is set in `.env.local` too (2026-07-13 — the leads-page Sync button re-imported 78 real website enquiries into dev mid-test; wiped + guarded).

## AI survey gotchas (2026-07-13)

- **`GEMINI_API_BASE_URL` MUST include `/v1beta`** (`https://generativelanguage.googleapis.com/v1beta`). `lib/ai/gemini.ts` polls file status at `${baseUrl}/${file.name}` and passes baseUrl into `createGoogle` — the bare origin 404s every analysis ("Gemini file status failed (404)"). Only the upload path tolerates both forms. Prod `app.env` fixed to the /v1beta form 2026-07-13. The intended pre-launch policy is `COMMS_DRYRUN=true`, but live `app.env` was verified as `COMMS_DRYRUN=false` on 2026-07-20; do not assume sends are simulated or change the flag without Peter's cutover decision.
- **Local dev has NO cron** — `ai_jobs` sit `queued` forever and the survey UI polls indefinitely. Drain manually while logged in as office: open `http://localhost:3015/api/cron/ai-jobs`.

## House conventions

- **Before ANY push: `npm run lint` locally, always** — the CI gate enforces ESLint
  rules tsc never sees (react-hooks, no-unused-vars, no-unescaped-entities). Running
  only tsc+vitest has now broken the pipeline twice (session 32 agents; 2026-07-22
  balance refactor). All four gates or it doesn't ship: lint, tsc, vitest, build.

- **Page shell (2026-07-16, Peter caught /content hugging the edge):** every `app/(dashboard)/**` page's top-level element must be `<main className="flex-1 p-6 md:p-8">` (or the deliberate `page-shell` variant used by the dashboard/estimator views). The shared layout adds NO padding on purpose — a bare `<div>` root renders flush against the viewport. Full 34-page audit passed 2026-07-16; keep it true for new pages.

## Current State

Last touched: 2026-07-29 on i9 — **PCI DSS SAQ A completed (Elavon portal) + first ASV scan FAILED → prod Postgres was publicly exposed; found and fixed. No app code changed.**
- **PCI:** business profile completed on Elavon Security Manager (MID `2102193798`) → **SAQ type A**. Marley is pure e-commerce / pay-by-link — **no card machine, no MOTO**; gateway declared as **Cardstream Limited** (takepayments isn't in their list). Quarterly ASV scanning scheduled against `ops.marleymoves.co.uk` (the box serves `/q/[token]`, so it — not the Vercel site — is the in-scope system).
- **SECURITY, the real find:** `supabase-pooler` published `0.0.0.0:5432/6543` via docker-proxy, which **bypasses UFW** — prod Postgres (all customer PII, jobs, payments) was reachable from the open internet behind only the DB password. ASV independently flagged it **High**. Fixed: `DOCKER-USER` chain DROPs both ports except i9, persisted by `docker-user-firewall.service` (Docker recreates that chain empty on daemon start). Drop rule **proven** by pulling the allow entry and re-testing, not just assumed.
- **Also fixed:** sshd offered `hmac-sha1`/`umac-64` MACs (ASV Medium) → `/etc/ssh/sshd_config.d/10-pci-macs.conf`, applied behind a `systemd-run` auto-revert net with a fresh-connection check. Both changes documented in `docs/ovh-deployment.md` → **"Network exposure"** (the old "UFW — only 22/80/443 open" line was actively misleading and has been corrected).
- **Rescan** queued and set to **recur quarterly**, so the ongoing obligation self-maintains.
- **OPEN (Peter's call, deliberately left):** the SAQ was attested with **8.3.6 / 8.3.7 / 8.3.9 recorded "Yes" when the truth is "No"** — marley-ops uses Supabase GoTrue password defaults (6 chars, no complexity, no history, no expiry) via `signInWithPassword`, passkeys optional. Correct those three + re-attest, then build the password policy (12-char, forced first change, history 4, 90-day expiry, or mandatory passkeys) — **ClickUp 869eb591y**, due 30 Sep 2026.
- Detail: memory [[marley-pci-compliance]] (incl. portal login); decisions log 2026-07-29.

_Prior sessions → brain `O:\brain\01_Projects\Marley Moves\marley-ops CHANGELOG.md` (full "Last touched" history, newest-first; query via `/recall`). This block holds the latest session only — `/ur` evacuates older blocks there. Deployment/ops runbook: `docs/ovh-deployment.md`; go-live checklist: `docs/go-live-checklist.md`._
