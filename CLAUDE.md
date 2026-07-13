@AGENTS.md

## Current State

Last touched: 2026-07-13 on i9 — premium role-based UI redesign merged to master, deployed to prod, and migration `0033` applied to the current VPS; next up is migrating the backend to a new OVH VPS.

**Where we left off:**
- **PR #5 merged to `master`** (`8aca4e0`) — the full premium role-based UI redesign + `/automations` log + unified contact icons + pre-production hardening sweep. Built on top of codex's merged AI-survey rollout (PR #4). Vercel auto-deployed it to prod (READY, `8aca4e0`). Gate green: lint 0 errors · tsc · 278 tests · build.
- **Migration `0033` (`cron_runs`) applied to the CURRENT prod VPS** (self-hosted Supabase on vps1, `178.105.182.36`, `supabase-db` container) + PostgREST reloaded. Prod was at `0032` (codex's `0031` AI-survey + `0032` storage already applied), so only `0033` was needed. Verified live: real `ai-jobs` crons writing `cron_runs` rows every 2 min. `/automations` is live at https://ops.marleymoves.co.uk/automations (office login).
- **`CRON_SECRET` + `SYNC_CRON_SECRET`** confirmed set in the `marley-ops` Vercel project (production). Vercel Cron auto-sends `CRON_SECRET`; `lib/api-auth.ts` accepts either.
- **Worktree consolidated:** the `codex/premium-role-ui` worktree + branch were the only ones besides the primary checkout; both removed after confirming 0 unique commits. The primary checkout `O:\projects\red-banana\clients\marley\marley-ops` on `master` is now the single working copy.

**Next move (in progress):** stand up the new **OVH VPS** (`vps-a0b9c066.vps.ovh.net`, `51.195.253.165`, ubuntu) and migrate the `ops.marleymoves.co.uk` backend (self-hosted Supabase + DB + storage) onto it, then cut Vercel/DNS over. At cutover, re-apply the migration chain on the new DB (or `0033` on top if restoring the current dump) and finish with `notify pgrst, 'reload schema';`.

**Where things live:** repo `redbananastudios/marley-ops` (master, PR workflow — codex + claude land via PRs). App at https://ops.marleymoves.co.uk. Backend currently self-hosted Supabase on vps1 (`178.105.182.36`); prod DB migrations applied via SSH → `docker exec supabase-db psql` + pgrst reload. Nightly prod backup: `scripts/backup-prod-db.ps1`. Local dev: Supabase Docker stack + `scripts/seed-dev.mjs`/`seed-dev-crew.mjs`; keep `SANITY_SYNC_DISABLED=true` in `.env.local`.

**Go-live checklist still open** (pre-full-launch, from prior sessions): generic terms legal review (ClickUp 869e35z42), SANITY_SYNC_DISABLED removal + lead backfill, `.test` team emails swapped for real ones, INBOUND_FORWARD_EMAIL/OPS_ALERT_EMAIL → office address, Stripe card button, iMVE cutover decision, deferred audit mediums (ClickUp 869e378hj). No blockers on the code — it's green and deployed.
