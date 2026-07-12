@AGENTS.md

## Current State

The premium role-based UI redesign (worktree `O:\projects\red-banana\clients\marley\marley-ops-ui-workflows`, branch `codex/premium-role-ui`) passed browser acceptance at all three role viewports on 12 Jul; QA fixes + Peter's live feedback (brand mark on the black rails, sharper 16px stroke-2 menu icons) + rollout pass 1 (crew brand headers, shared EmptyState, Pipeline Board naming) are committed locally (`1fe1be4`, `b196497` — NOT pushed). Remaining refinements are listed in `docs/ui-role-workflows-handoff.md` "Remaining after pass 1". Local dev: Supabase Docker stack + `scripts/seed-dev.mjs` / `seed-dev-crew.mjs`; keep `SANITY_SYNC_DISABLED=true` in `.env.local` (the dashboard otherwise syncs REAL leads from prod Sanity into dev). Do not edit the primary checkout.
