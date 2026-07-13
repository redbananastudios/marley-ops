@AGENTS.md

## Current State

Last touched: 2026-07-13 on i9 — **Marley Ops fully migrated off Vercel + shared vps1 onto a dedicated OVH VPS**, with GitHub CI/CD. Migration complete and end-to-end verified.

**Where it runs now (all on the OVH VPS `51.195.253.165` / `vps-a0b9c066`):**
- **App** `ops.marleymoves.co.uk` — Next.js standalone Docker container (`marley-ops-app`), fronted by **Caddy** (auto Let's Encrypt TLS).
- **Backend** `supabase.redbananastudios.com` — the full self-hosted Supabase stack (11 services), a byte-faithful clone of the old vps1 DB (data hashes verified equal), same JWT/anon/service keys so no session breakage.
- **Cron** — 7 jobs via on-box `/etc/cron.d/marley-ops` (fires every 2 min, verified unattended). Replaces Vercel Cron.
- **Env** — `/opt/marley-ops/app.env` (54 vars, assembled from Vercel + credentials.env).
- Both IONOS DNS records A → the box (TTL 60). All containers `restart: unless-stopped`.

**CI/CD (new):** push to `master` → `.github/workflows/deploy.yml` runs the test gate (lint/tsc/278 tests) on a GitHub-hosted runner, then a **self-hosted runner on the OVH box** builds + restarts the app + health-checks. Runner = systemd service `actions.runner.redbananastudios-marley-ops.ovh-vps`. Manual fallback: `bash scripts/deploy-ovh.sh` from i9.

**Full ops + rollback runbook: `docs/ovh-deployment.md`.** Covers VPS access (`ubuntu@51.195.253.165`, key `~/.ssh/rbs_vps`, key-only SSH + UFW), deploy, DB migrations (SSH → `docker exec supabase-db psql` + pgrst reload), env changes, nightly backup (`scripts/backup-prod-db.ps1` → OVH, verified), and rollback.

**Vercel: DELETED** (2026-07-13, per Peter — no longer needed). The old **vps1 Supabase** (`178.105.182.36`) is left running short-term as a backend rollback; decommission once the OVH box has bedded in (stop its `supabase-*` stack, raise DNS TTLs back to 3600). New sudo password for the box recorded with Peter (break-glass; SSH is key-only).

**Prior state (still current):** PR #5 (premium role UI + /automations + hardening) is merged + live; migration `0033` (`cron_runs`) applied. **Go-live checklist still open:** generic terms legal review (ClickUp 869e35z42), SANITY_SYNC_DISABLED removal + lead backfill, `.test` team emails → real, INBOUND_FORWARD_EMAIL/OPS_ALERT_EMAIL → office address, Stripe card button, iMVE cutover decision, deferred audit mediums (ClickUp 869e378hj). No blockers on the code — green, deployed, self-hosted.
