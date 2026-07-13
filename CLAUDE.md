@AGENTS.md

## Data policy until go-live (Peter, 2026-07-13)

**Production `ops.marleymoves.co.uk` holds MOCK/TEST data only until Peter approves testing complete.** No live-lead backfill, no real customer records, keep `SANITY_SYNC_DISABLED` in place. The `growth_artifacts` rows are exempt (agent proposals + tracking summaries — no customer data). Do not flip anything to live data without his explicit approval.

## AI survey gotchas (2026-07-13)

- **`GEMINI_API_BASE_URL` MUST include `/v1beta`** (`https://generativelanguage.googleapis.com/v1beta`). `lib/ai/gemini.ts` polls file status at `${baseUrl}/${file.name}` and passes baseUrl into `createGoogle` — the bare origin 404s every analysis ("Gemini file status failed (404)"). Only the upload path tolerates both forms. Prod `app.env` fixed to the /v1beta form 2026-07-13. Also `COMMS_DRYRUN=true` on prod until go-live (mock-data policy) — flip to `false` at launch.
- **Local dev has NO cron** — `ai_jobs` sit `queued` forever and the survey UI polls indefinitely. Drain manually while logged in as office: open `http://localhost:3015/api/cron/ai-jobs`.

## Current State

Last touched: 2026-07-13 on i9 — **Growth section MERGED + LIVE on prod** ([PR #6](https://github.com/redbananastudios/marley-ops/pull/6) merged, CI deploy green). Office-only nav group: `/growth` (launch readiness — verdict, tracking gaps card with per-platform missing events, leads-by-variant on `utm_content`, artifact freshness) and `/growth/ads` (proposal-only creative matrix, ChatGPT Ads brief, optimizer recs). Migration `0034` (`growth_artifacts`) applied to BOTH local dev and prod Supabase; 10 artifacts in each. Delivery: `O:\RBS-OS\agents\tools\growth_push_ops.py` (PostgREST for dev; `--emit-sql` piped over SSH+psql for prod, so the service key never leaves the VPS), refreshed nightly by i9 task `AIOS Growth Ops Push` (07:00). Tracking validation runs for real against PostHog project 202362: status **fail** — GA4 fires 5/9 critical events (all missing `variant_key`), PostHog 0/9 canonical. Launch stays blocked until the site fires the spec events and validation passes. 293/293 tests.

Earlier same day — **Marley Ops fully migrated off Vercel + shared vps1 onto a dedicated OVH VPS**, with GitHub CI/CD. Migration complete and end-to-end verified.

**Where it runs now (all on the OVH VPS `51.195.253.165` / `vps-a0b9c066`):**
- **App** `ops.marleymoves.co.uk` — Next.js standalone Docker container (`marley-ops-app`), fronted by **Caddy** (auto Let's Encrypt TLS).
- **Backend** `supabase.redbananastudios.com` — the full self-hosted Supabase stack (11 services), a byte-faithful clone of the old vps1 DB (data hashes verified equal), same JWT/anon/service keys so no session breakage.
- **Cron** — 7 jobs via on-box `/etc/cron.d/marley-ops` (fires every 2 min, verified unattended). Replaces Vercel Cron.
- **Env** — `/opt/marley-ops/app.env` (54 vars, assembled from Vercel + credentials.env).
- Both IONOS DNS records A → the box (TTL 60). All containers `restart: unless-stopped`.

**CI/CD (new):** push to `master` → `.github/workflows/deploy.yml` runs the test gate (lint/tsc/278 tests) on a GitHub-hosted runner, then a **self-hosted runner on the OVH box** builds + restarts the app + health-checks. Runner = systemd service `actions.runner.redbananastudios-marley-ops.ovh-vps`. Manual fallback: `bash scripts/deploy-ovh.sh` from i9.

**Full ops + rollback runbook: `docs/ovh-deployment.md`.** Covers VPS access (`ubuntu@51.195.253.165`, key `~/.ssh/rbs_vps`, key-only SSH + UFW), deploy, DB migrations (SSH → `docker exec supabase-db psql` + pgrst reload), env changes, nightly backup (`scripts/backup-prod-db.ps1` → OVH, verified), and rollback.

**Vercel: DELETED** and **vps1 Supabase: TORN DOWN** (both 2026-07-13, per Peter — the OVH box is now the sole live copy; Red Taxi on vps1 untouched). Final vps1 snapshot + on-disk data kept as safety nets (`backups/marley-ops-vps1-final-*.dump`; vps1 `/opt/rbs/supabase/volumes`). All testing happens on the new VPS; real-lead backfill (SANITY_SYNC_DISABLED) is a later go-live step. New sudo password for the box recorded with Peter (break-glass; SSH is key-only).

**Prior state (still current):** PR #5 (premium role UI + /automations + hardening) is merged + live; migration `0033` (`cron_runs`) applied. **Go-live checklist still open:** generic terms legal review (ClickUp 869e35z42), SANITY_SYNC_DISABLED removal + lead backfill, `.test` team emails → real, INBOUND_FORWARD_EMAIL/OPS_ALERT_EMAIL → office address, Stripe card button, iMVE cutover decision, deferred audit mediums (ClickUp 869e378hj). No blockers on the code — green, deployed, self-hosted.
