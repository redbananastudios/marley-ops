# Marley Ops — OVH self-hosted deployment (runbook)

As of **2026-07-13** `ops.marleymoves.co.uk` + its Supabase backend run entirely on a
dedicated **OVH VPS** — off Vercel and off the shared vps1. This is the operations +
rollback reference.

## Where everything runs

| Piece | Detail |
|---|---|
| **VPS** | `vps-a0b9c066.vps.ovh.net` · `51.195.253.165` · Ubuntu 26.04 · 6 vCPU / 11 GiB / 96 GB |
| **SSH** | `ubuntu@51.195.253.165`, key `~/.ssh/rbs_vps` (i9). **Key-only** (password login disabled). Passwordless sudo. |
| **Firewall** | UFW — only 22 / 80 / 443 open |
| **App** | Docker container `marley-ops-app` (image `marley-ops:latest`, Next.js standalone), on the `rbs` network, published `127.0.0.1:3000` |
| **Backend** | Supabase stack under `/opt/rbs/supabase` (`docker compose`), 11 services, on `rbs` |
| **Reverse proxy** | Caddy (`/opt/rbs/caddy`) — auto Let's Encrypt TLS. Routes `ops.marleymoves.co.uk`→app:3000, `supabase.redbananastudios.com`→supabase-kong:8000. Has internal network aliases for both hostnames so the app reaches the backend without a public hairpin. |
| **App env** | `/opt/marley-ops/app.env` (chmod 600, 54 vars) — the runtime env; also holds the `NEXT_PUBLIC_*` build args |
| **Cron** | `/etc/cron.d/marley-ops` → `cron-hit.sh` fires the 7 jobs against `localhost:3000` with `CRON_SECRET` (replaces Vercel Cron) |
| **DNS** | Both records A → `51.195.253.165`, at IONOS, TTL 60 |
| **Backups** | `scripts/backup-prod-db.ps1` (nightly on i9, 02:30) → SSH pg_dump from the OVH `supabase-db` → `../backups` |

## Deploy an app update

**Primary — GitHub CI/CD (automatic).** Push to `master` → `.github/workflows/deploy.yml`
runs the test gate (lint + tsc + 278 tests) on a GitHub-hosted runner, then, only if
green, the **self-hosted runner on the OVH box** builds the image (baking `NEXT_PUBLIC_*`
from `/opt/marley-ops/app.env`), restarts `marley-ops-app`, and health-checks `/login`.
Nothing else to do — just `git push`. Trigger manually via the Actions tab
(`workflow_dispatch`) if needed.

- Runner service: `actions.runner.redbananastudios-marley-ops.ovh-vps` (systemd, enabled).
  Health: `sudo ./svc.sh status` in `/opt/actions-runner`. Re-register with a fresh token
  from `gh api -X POST repos/redbananastudios/marley-ops/actions/runners/registration-token`.

**Fallback — manual push from i9** (if the runner is down): `bash scripts/deploy-ovh.sh`
transfers the working tree, rebuilds, restarts, and smoke-tests.

## Apply a DB migration to prod

```bash
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "sudo docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < supabase/migrations/00NN_x.sql
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "sudo docker exec supabase-db psql -U postgres -d postgres -c \"notify pgrst, 'reload schema';\""
```

## Change an env var

Edit `/opt/marley-ops/app.env` on the box, then `sudo docker restart marley-ops-app`.
If it's a `NEXT_PUBLIC_*` var it must also be rebuilt (re-run `deploy-ovh.sh`).

## Rollback

**Vercel is deleted** (2026-07-13) — there is no longer a warm app fallback. Options:

- **Bad deploy** → roll the app back on the box: `git revert` + push (CI/CD redeploys the
  previous code), or on the box run a prior image tag / `sudo docker run … marley-ops:<prev>`.
- **Backend problem / catastrophic box loss** → the OVH box is now the only live copy
  (the old vps1 Supabase was **torn down 2026-07-13**). Recover by standing up a new box
  (Docker + Caddy + the `supabase/` stack), restoring the DB from the latest
  `../backups/marley-ops-*.dump` (nightly) — the final vps1 snapshot is
  `../backups/marley-ops-vps1-final-*.dump` — redeploying the app from git, and repointing
  both DNS records. Zone IDs: marleymoves.co.uk `1197dceb-63ff-11ef-adf4-0a5864441bc4`;
  redbananastudios.com `6da2bd83-2610-11f1-8196-0a5864441a59`.

## Decommission

- ✅ Vercel `marley-ops` project — **deleted 2026-07-13**.
- ✅ vps1 `supabase-*` stack — **torn down 2026-07-13** (`docker compose down`; Red Taxi on
  vps1 untouched). On-disk data left at `/opt/rbs/supabase/volumes` on vps1 as a short-term
  safety net — delete it (`docker compose down -v` + `rm -rf volumes`) once fully confident.
- Optional: raise the two IONOS DNS TTLs back to 3600 once the setup has stabilised.
