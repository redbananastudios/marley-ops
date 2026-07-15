# Web Push — implementation record (v1, 2026-07-15)

Requirements baseline: [marley-ops-web-push-prd.md](./marley-ops-web-push-prd.md). This note records the
Phase 0 discovery answers, the product decisions Peter locked, and how to operate/roll back the feature.

## Phase 0 discovery (PRD §5)

| Question | Answer |
|---|---|
| Stack | Next.js 16 App Router, React 19, TypeScript, npm, vitest, eslint |
| Runtime | Long-lived Node 22 Docker container on the OVH VPS (NOT serverless) → bounded awaited post-commit sends are safe |
| API | Same app: server actions + route handlers; secrets in `/opt/marley-ops/app.env` |
| HTTPS | Everywhere via Caddy (`https://ops.marleymoves.co.uk`); localhost dev exception |
| Auth | Supabase GoTrue session cookies via `proxy.ts`; stable user ids + roles (admin/estimator/crew) |
| DB | Self-hosted Supabase Postgres, numbered migrations (this feature = `0041_web_push.sql`) |
| Tenancy | Single tenant — no tenant columns |
| Prior PWA | NONE existed (no manifest/SW/plugin) — greenfield, no competing worker |
| Feature flags | `business_settings` columns (DB-backed, no redeploy) |
| Cron | `/etc/cron.d/marley-ops` → `cron-hit.sh` with `CRON_SECRET` (available for future cleanup jobs) |
| Queue | None; v1 uses bounded awaited fan-out after commit (tiny office recipient set) — PRD §12.2 compromise recorded |
| Realtime | None — the web-lead banner polls (20s) |

## Product decisions (Peter, 2026-07-15)

1. **v1 categories:** `new_enquiry` + `payment_event` (deposit AND balance), plus `crew_job`
   (added same day — "we do need push notifications to crew when a new job is allocated, or when
   they are removed from a job"). Follow-ups deferred.
2. **Devices supported:** iPhone (installed PWA), office iPad (installed PWA), Android, desktop
   Chrome/Edge.
3. **Audio-alert conflict rule:** while a Marley Ops window is focused, the SW suppresses the OS
   notification for `new_enquiry` (the in-app banner + chime own it) and messages the page to poll
   instantly. `payment_event` always shows.
4. **Logout does NOT revoke** (deviation from PRD recommendation — Peter's call). Consequence: a
   shared device notifies whoever last enabled notifications there, even after they log out. A
   different user enabling on that browser transfers the endpoint to them (one owner per endpoint,
   enforced by the unique `endpoint_hash`). Revisit if crew categories arrive on shared devices.
5. **Admin self-test button:** yes — fixed copy, self-targeting, 3 sends / 10 min (in-memory limit,
   resets on container restart).
6. Defaults adopted: actor excluded from their own events; first-name-only copy (never address,
   phone, or £ amount); every category user-optional; preferences user-wide; kill switches default
   **push_enabled=false** until Peter validates on his devices.

## Architecture (what shipped)

- `public/sw.js` — push-only worker (deliberately NO fetch/caching handler; offline shell is out of
  scope). Deep-link allowlist duplicated from `lib/push/payload.ts`, pinned by a lockstep test.
- `app/manifest.ts` + `public/icons/*` (real brand icons shared with the quotes app) + apple-webapp
  metadata → installable PWA, required for iOS push.
- `proxy.ts` matcher excludes `sw.js` + `manifest.webmanifest` (auth 307 would break both).
- `lib/push/` — `categories.ts` (registry + copy + digest rule), `payload.ts` (wire contract +
  allowlist), `transport.ts` (web-push wrapper + error classification), `send.ts` (recipient
  resolution, fan-out, 404/410 pruning, redacted logging; never throws), `client.ts` (UI state
  machine, iOS install detection, base64).
- `app/actions/push.ts` — config / subscribe / unsubscribe / reconcile / preferences / admin flags /
  test send. Ownership always session-derived.
- Settings › Notifications card (`components/settings/notifications-card.tsx` +
  `components/push/notifications-setup.tsx`) — all PRD §16.2 states, contextual pre-prompt, never
  auto-prompts.
- Event wiring: `lib/sync/sanity-leads.ts` (fresh-window + >3 → digest so the cutover backfill stays
  silent), `lib/quote/accept-flow.ts` `markDepositPaid` / `markBalancePaid` (after each idempotency
  gate; actor excluded).
- **Crew job assignments** (`crew_job`, migration 0042): `lib/push/crew.ts` fires from the three Job
  Board assignment actions after the write commits. Targeted at the specific member via
  `staff.profile_id` (no linked login → silent); skipped for cancelled/past appointments; assignment
  and removal share one notification tag so a removal REPLACES the stale "you're on this job" alert.
  Copy is day-only ("You've been put on a job on Sat 18 Jul.") — details live behind the /my-jobs
  deep link. Crew enable from the "Get job alerts on this phone" row on /my-jobs (they never see
  Settings); config/preferences are role-scoped so each user only sees categories they can receive.

## Operations

- **Env (server-only, in `/opt/marley-ops/app.env` + `.env.local`):** `WEB_PUSH_VAPID_PUBLIC_KEY`,
  `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT` (mailto). Keys generated with
  `npx web-push generate-vapid-keys`. NEVER rotate casually — rotation orphans every subscription
  (users must re-enable). Recovery: generate a new pair, update env, restart, ask users to re-enable.
- **Kill switches (no deploy):** Settings › Notifications › Business-wide switches (admin), or SQL:
  `update business_settings set push_enabled = false where id = true;`
- **Logs:** structured `push.*` events (`push.event.sent`, `push.send.failed`,
  `push.subscription.pruned`). Endpoints appear only as 12-char hash prefixes; keys never logged.
- **iOS caveat:** push only works for the installed Home Screen app; the settings card walks users
  through Add to Home Screen. Delivery is best-effort everywhere (browser/OS may defer or suppress).
- **Rollback ladder:** flip `push_enabled` off → per-category switch → revert the deploy. Never
  delete VAPID keys as a rollback.
