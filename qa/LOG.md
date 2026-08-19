# QA audit run log

Append-only, newest first. One entry per run: timestamp · sha audited · verify-first results · items tested per agent · findings filed / specs added · pushes · cleanup verification counts · time spent.

---

## 2026-08-19 — run skipped: missing staging credentials

- sha audited: e1eeb1c (origin/staging, HEAD at checkout)
- Verified all three required env vars per AUDIT.md step: `QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY`, `QA_STAGING_CRON_SECRET` — **all three missing** from the environment.
- No testing performed, no findings filed, no specs added, no cleanup needed.
- Did not improvise credentials from any other source. Stopping cleanly per instructions.
- Time spent: <5 min (credential check only).

---

## 2026-08-19 — run aborted: staging domain blocked by network egress policy

- sha audited: 4498b07 (origin/staging, HEAD at checkout)
- Credential check per AUDIT.md step: `QA_STAGING_SUPABASE_URL`, `QA_STAGING_SERVICE_KEY`, `QA_STAGING_CRON_SECRET` all present.
- Health gate: `curl https://staging.ops.marleymoves.co.uk/api/version` failed — proxy returned `CONNECT tunnel failed, response 403`. Confirmed via `$HTTPS_PROXY/__agentproxy/status`: `recentRelayFailures` shows `connect_rejected` / "gateway answered 403 to CONNECT (policy denial or upstream failure)" for `staging.ops.marleymoves.co.uk:443`. Cross-checked with the WebFetch tool, which returned `EGRESS_BLOCKED` for the same domain — a second, independent path confirming this is a non-transient organization egress policy denial, not a flaky connection. Per the proxy's own guidance (`/root/.ccr/README.md`): "do not retry or route around it — report the blocked host."
- This session's network policy does not allow reaching the deployed staging site at all, which the entire audit (health gate, all four role agents, all handoff scenarios, Playwright specs) depends on. No DB seeding, no browser testing, no findings filed, no specs added — nothing was attempted beyond the connectivity check, per the abort conditions ("staging unreachable").
- No marker rows were created, so no cleanup is required.
- No code/spec changes beyond this log entry; pushing to `staging` only.
- **For Peter:** this run's environment (the scheduled/cloud host running this session) needs `staging.ops.marleymoves.co.uk` allow-listed in its egress policy, or the QA schedule needs to run from a host whose policy already allows it (e.g. i9), or the audit can't execute.
- Time spent: <10 min (credential + connectivity check only).
