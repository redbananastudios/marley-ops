# Marley Ops final release review — 20 July 2026

## Verdict

**Code verdict: release-ready after migration `0069_crew_rls_lockdown.sql` is applied to production in the same release.** The review found release-blocking authorization, race, offline-data-isolation and observability defects; all are fixed on `codex/final-release-review` and verified in the development stack. Production data, production schema and the live deployment were not changed by this review.

**Business go-live verdict: still conditional.** Keep production mock-only, `SANITY_SYNC_DISABLED=true` and `COMMS_DRYRUN=true` until the manual cutover gates in this report are signed off. Those gates are operational/legal inputs, not unresolved code defects.

Review base: latest `origin/master` at `f68c285` (ahead/behind `0/0` when frozen). Dedicated worktree: `O:\projects\red-banana\clients\marley\marley-ops-final-release`.

## Release-blocking findings fixed

| Severity | Finding | Resolution and evidence |
|---|---|---|
| P0 | Every active login satisfied legacy `is_staff()` policies, so a crew JWT could enumerate CRM/fleet/claims-adjacent records, mutate several operational tables and access unassigned storage objects directly. | Migration 0069 makes operational tables office-only, preserves only a narrowly scoped own-staff read/first-login link, and adds assignment-scoped storage helpers. A live dev crew JWT now sees its own profile/staff row and zero rows across all 19 restricted tables. The only remaining policy containing `is_staff()` is the own-row `staff_read` policy. |
| P0 | Service-role crew actions trusted authentication but did not consistently prove current job assignment. | Central `lib/job-access.ts` gate now requires an active actor; crew must be assigned to a non-cancelled appointment. Contract signing, completion, job notes, capture context/upload/record/discard/consent and later note/media edits are assignment-scoped. Office roles retain legitimate access. |
| P0 | An inactive account with a still-valid refresh token could retain some app/API and own-staff access. | `getSessionProfile`, `/my-jobs`, crew pay, cron/manual route auth, staff RLS and first-login linking all fail closed on `active=false`. Same-token dev proof: profile bootstrap remains readable, but staff and CRM counts become zero immediately; the test profile was restored afterwards. |
| P0 | Survey photo service-role/R2 actions allowed any active profile, and delete trusted a caller-supplied object path. | All survey actions now require an active office profile. Delete loads the stored path by photo ID, demands an exact match and binds both object and row deletion to that stored path. |
| P0 | Online quote acceptance could mark the quote accepted before durable contract evidence, then raise deposit side effects; accept/decline races could report the wrong result. | Acceptance is compare-and-set, verifies replay evidence, checks signature insert errors and conditionally rolls back only its own accepted stamp. Side effects cannot run without signature evidence. Decline checks database errors and reports success only when rejection actually won. |
| P1 | Offline completion records were device-global, so shared tablets could display/replay another user's queued submission; failed items were not actually re-armed by Retry. | Every item now carries `ownerId`; the physical store is owner-scoped and legacy unowned records are quarantined. Retry explicitly resets failed state before flushing. Offline completion and double-submit browser tests pass. |
| P1 | Upload targets accepted missing/non-integer declared sizes and weak MIME declarations, allowing presigned uploads to escape intended size/type controls. | Survey/job photo and job-media targets require positive safe integer byte sizes, bind `Content-Length`, enforce 30 MB image/audio and 300 MB video caps, and normalize MIME families. |
| P1 | Scheduled/manual API auth accepted any signed-in user; structured cron `{ok:false}` results were logged as successful; fleet reminders were missing from the registry. | Manual runs now require an active admin/estimator or scheduler secret. `runCron` converts structured failures to failed runs. Registry tests discover every cron/sync route and fleet reminders are registered. |
| P1 | Service-worker cache writes could be terminated before `cache.put`/trim completed. | Cache mutation and trim are awaited inside fail-soft blocks, keeping successful network responses available while making cache persistence reliable. |
| P1 | Quote-list debounced search could race a fast row click and pull the user back to `/quotes?q=…`. | Pending replacement navigation is cancelled for a normal row navigation, while modified-clicks remain unaffected. The exact failing browser scenario is green in standalone production mode. |

## Performance improvements applied

| Area | Change | Measured/expected impact |
|---|---|---|
| Capture UI | Moved the camera/video/voice sheet behind a dynamic launcher and keep it mounted only after first use. | Measured route gzip reduction: dashboard 6,261 B; content 6,269 B; lead detail 10,644 B; crew job 5,161 B. Heavy media logic no longer taxes users who never open capture. |
| Onboarding | Dynamically load `driver.js` and its CSS only when a tour starts. | Defers 23,302 B gzip JavaScript and 3,042 B gzip CSS from normal navigation. |
| Fonts/media | Disabled unnecessary Geist Mono preload; changed content-review videos from metadata preload to no preload. | Avoids 23,108 raw font bytes at initial load and prevents list pages from opening a range request per video. |
| Dashboard | Starts external analytics and needs-action queries in parallel with all-time KPI pagination. | Removes independent PostHog/Google Ads/fleet/claims/follow-up latency from the serial critical path. |
| Zoho | Coalesces concurrent token refreshes and adds 10-second abort deadlines to token, API and PDF requests. | Prevents refresh stampedes and bounds dashboard/finance stalls during provider degradation. |
| Deploy skew | Sets Next.js `deploymentId` from `NEXT_PUBLIC_BUILD_SHA`. | Stale clients hard-reload across container handovers instead of issuing old Server Action IDs against a new image. Standalone build contained `deploymentId=review-f68c285`. |
| Dependencies | Updated safe lockfile-only `brace-expansion` and `js-yaml` versions. | Removes the directly fixable audit findings without forcing a framework downgrade. |

## Page-by-page review matrix

All 49 `page.tsx` entry points and all 23 API routes were inspected. The browser access suite also loads every office and crew route under its real role. “No release finding” means authorization, query shape, error state, client weight and navigation were checked; it does not imply the page is feature-frozen forever.

| Surface | Pages reviewed | Result |
|---|---|---|
| Auth/public shell | `/login` | No release finding. Production-mode auth verified for admin, estimator and crew. |
| Public customer journeys | `/q/[token]`, `/s/[token]`, `/cv/[token]`, `/sheet/[token]` | Quote accept/decline race hardened; storage/cubic/day-sheet token boundaries retained. Quote view/decline automated paths pass. Money-creating Zoho/card legs remain deliberately sandbox/manual gated. |
| Dashboard | `/` | Independent external/attention queries parallelized. All-time KPI reads already paginate. External integrations remain fail-soft. |
| Pipeline | `/leads`, `/leads/new`, `/leads/[id]`, `/board`, `/follow-ups` | Lead access and workflow transitions pass. Lead-detail joins are grouped in two `Promise.all` phases; a later optimization can flatten remaining dependent waterfalls after profiling. Capture code removed from initial lead bundle. |
| Cubic survey | `/leads/[id]/cubic`, `/review`, `/scan` | Office route/access and storage signing reviewed. Survey service actions are now office-only and path-bound. AI/file analysis constraints unchanged. |
| Quotes/sales | `/quotes`, `/quotes/new`, `/quotes/[id]`, `/bookings`, `/payments` | Search/navigation race fixed. Quote builder, acceptance, decline, deposit/balance and bank/card state transitions reviewed. Automated list, wizard and public quote scenarios pass. |
| Schedule/jobs | `/schedule/board`, `/schedule/removals`, `/schedule/surveys`, `/jobs` | Job board uses paginated parallel resource reads. Survey schedule paginates. Removal calendar is still a bounded-at-current-scale P2 because its three direct selects rely on the PostgREST row cap. |
| Customers/claims/content | `/clients`, `/clients/[id]`, `/claims`, `/claims/[id]`, `/documents`, `/content` | Access and object signing reviewed. Capture is deferred; videos no longer preload. Claim evidence and content approval boundaries retained. |
| Finance/contractors | `/finance`, `/finance/statements`, `/estimator`, `/estimator/pay`, `/estimator/pay/[id]` | Office/admin role boundaries, Zoho failure behavior and pay privacy reviewed. Provider latency is now bounded/coalesced. |
| Crew PWA | `/my-jobs`, `/my-jobs/[id]`, `/availability`, `/agreement`, `/manual`, `/pay`, `/pay/[id]` | Active-session shell gate, owner-scoped offline queue and assignment-bounded service-role reads/actions implemented. Complete crew browser suite passes. |
| Operations | `/storage`, `/resources`, `/performance`, `/automations`, `/settings`, `/manual` | Role access and query/error states reviewed. Fleet cron is registered; manual cron execution is office-only. No release finding. |
| Growth | `/growth`, `/growth/ads` | Read-only/proposal surfaces reviewed; no release finding. Existing tracking readiness verdict remains a business launch input, not an Ops runtime defect. |

## Function-by-function high-risk review

| Domain/functions | What was checked | Outcome |
|---|---|---|
| `acceptQuoteOnline`, `declineQuoteOnline`, deposit invoice side effects | CAS winner semantics, replay, evidence durability, accept-vs-decline messaging, rollback ownership | Hardened; public accept/decline scenarios pass. |
| `getActiveJobActor`, `requireAppointmentAccess`, `crewAssignedToAppointment` | Database-derived role, active profile/staff, cancelled jobs, assignment and email fallback | Centralized and covered by unit/security tests. |
| Crew signature/completion actions | UUID validation, assignment, legal acknowledgements/signatures, idempotent completion, customer email boundary | Assignment enforced; 26-test crew suite includes offline and double-submit paths. |
| Job note actions | Assignment, author ownership, path validation, upload size, safe object cleanup | Add/upload/discard require assignment; deletion requires current assignment plus authorship (office bypass retained). |
| Job media actions | Direct-lead vs appointment anchor, assignment, ownership, consent, approval freeze, MIME/size/path validation | Crew anchors are appointment-only and assignment-scoped; edits require current assignment plus ownership; approval/delete are office-only. |
| Survey actions | Office role, active status, RLS-visible survey, path and size, service-role delete binding | All entry points office-gated; delete uses stored path. |
| `getSessionProfile`, crew layouts/pay reads, API cron guards | Valid auth token vs active business access | Inactive sessions fail closed at shared boundaries and in RLS. |
| Offline `enqueue`, scoped store, `flushOutbox`, `retryFailed` | Shared device isolation, per-owner dedupe, permanent failure visibility, explicit retry | Owner isolation and retry state fixed; legacy records quarantined. |
| `runCron`, cron registry | Throwing and structured failures, watchdog truth, route/registry drift | False greens removed; route-discovery test covers all cron/sync handlers. |
| Service worker cache functions | Event lifetime, cache failure, redirects/login poisoning, trim ordering | Writes/trims awaited; cache remains fail-soft; login redirects still excluded. |
| Zoho client/token cache | Concurrency, failure deadline, credential leakage, PDF path | One refresh in flight; 10-second timeout; secrets remain runtime-only. |
| Dashboard loaders | PostgREST 1,000-row cap, parallelizable I/O, fail-soft external panels | All-time KPI reads paginate; independent work begins concurrently. |
| Upload-limit helpers | `NaN`, infinity, fractional/zero/missing/over-cap sizes and MIME fallback | Positive safe integers required and targets are length-bound. |
| Quote list navigation | Debounce cleanup, SPA navigation, modified clicks | Race fixed without breaking Ctrl/Cmd/Shift-click behavior. |

## API/automation review

The 23 API handlers were checked as four classes:

- Cron/sync (13): scheduler-secret/office boundaries, `runCron` logging, registry/watchdog coverage and structured failure behavior. Fleet reminders were the sole registry gap and are now covered.
- Money/provider callbacks (2): card callback signature/idempotency and return-page separation retained.
- AI/maps/places/automation state (7): session/office access, bounded provider errors and response shaping reviewed; no new release blocker.
- Resend inbound webhook (1): Svix signature and robot/loop guards are present. Replay idempotency remains a P2 below.

## Verification evidence

| Gate | Result |
|---|---|
| Latest code / lineage | `origin/master` fetched; review base `f68c285`; ahead/behind `0/0`. |
| Clean install | `npm ci` installed 617 packages. |
| Unit/integration | **81 files, 828 tests passed** after final changes. |
| TypeScript | `tsc --noEmit` passed after final changes. |
| ESLint | **0 errors**; 34 existing React-compiler warnings (same baseline class/count). |
| Production build | Next.js 16.2.9 standalone build passed; 73 app/API routes compiled; build-time public env mirrored Docker; deployment ID verified. |
| Full browser coverage | Full suite exercised 108 automated scenarios with six intentionally skipped manual/sandbox money scenarios. One quote-search race failed, was fixed, and its exact case passed on re-run. |
| Post-hardening browser | 26/26 crew tests and 32/32 office access/lead/quote-builder tests passed against migration 0069. |
| Standalone browser | Docker-equivalent standalone server: three-role auth, crew job-note flow and quote search/open all passed (5/5). |
| RLS SQL | Migration executed inside `BEGIN … ROLLBACK` with `ON_ERROR_STOP`, then applied to development and PostgREST reloaded. Production not touched. |
| Live crew JWT probe | Active: profile=1, own staff=1, 19 restricted tables all zero. Inactive same token: bootstrap profile=1, staff=0, CRM=0. Profile restored active. |
| Policy inspection | `pg_policies` contains no broad `is_staff()` policy; only assignment-safe own-row `staff_read` remains. |
| Communications/data safety | Every E2E/dev run used `COMMS_DRYRUN=true`, `SANITY_SYNC_DISABLED=true`; staging Zoho cleanup ran; production untouched. |

The six non-automated scenarios are explicit rather than false-green. The staging-Zoho deposit and balance legs did run; the documented skips are:

1. Full refund/credit note and VAT reversal (manual Zoho workflow).
2. Deposit forfeit decision (manual Zoho workflow).
3. Partial credit note after a day-of price reduction (manual Zoho workflow).
4. Cross-quarter VAT tax-point attribution (unit-covered; UI cannot backdate Zoho invoices).
5. Declined card authorization (requires takepayments sandbox credentials/PAN).
6. Bank-feed transfer → deposit/state transition (requires the bank-feed sandbox/staging seam).

## Remaining non-blocking engineering work

These are not reasons to hold the initial release at current volume, but should enter the post-launch backlog in this order:

1. **P2 — inbound webhook replay idempotency.** `app/api/webhooks/resend-inbound/route.ts` verifies Svix and loop/robot guards but does not persist/claim the webhook event ID before forwarding/logging. Add a unique event ledger so provider retries cannot duplicate forwards or alerts.
2. **P2 — outbound communication claim-before-send.** `lib/comms/dispatch.ts` checks duplicates, sends, then inserts the unique communication row. A narrow concurrent race can still double-send before one insert loses. Move to a durable claim/lease/outbox pattern; provider-side idempotency should be used where available.
3. **P2 — removals calendar pagination.** `app/(dashboard)/schedule/removals/page.tsx` runs its reads concurrently but still relies on default PostgREST limits. Replace direct selects with date-windowed/paginated reads before appointments/leads can exceed 1,000 rows.
4. **P2 — profile lead-detail latency.** `app/(dashboard)/leads/[id]/page.tsx` already groups most work, but still has two dependent I/O phases. Capture server timings after launch, then flatten or cache only the measured hot joins.
5. **P3 — route loading boundaries.** Add targeted `loading.tsx` skeletons for the heaviest schedule/finance/lead routes if real-user RUM shows navigation latency; do not add global visual churn without evidence.
6. **P3 — React compiler warnings.** The 34 warnings are pre-existing and non-failing, mostly intentional state reseeding in effects or incompatible-library notices. Reduce them component-by-component after release, guarded by behavior tests.
7. **P3 — residual dependency advisory.** `npm audit` reports two moderate records for Next.js's bundled PostCSS `<8.5.10`. `npm audit fix --force` proposes a destructive downgrade to Next 9.3.3, so it was rejected. Track the framework fix and upgrade normally.

## Required release sequence

1. Review and merge this branch.
2. Take/verify the normal production backup.
3. Apply migration 0069 to production with `ON_ERROR_STOP`; reload PostgREST; run the active/inactive crew JWT assertions against production in a rollback-safe transaction where mutation is involved.
4. Build the Docker image with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL` and the merged `GIT_SHA` exactly as `.github/workflows/deploy.yml` already does.
5. Deploy once, retain the previous image, verify `/api/version`, three-role login, `/my-jobs`, `/quotes`, public quote view and one cron health row. The new deployment ID protects clients from version skew.
6. Keep mock-only flags on until Peter explicitly authorizes the data/comms cutover.

## Human/business cutover gates

- Obtain/record insurer policy details (insurer, excess, notification deadline) and close the TEST claim after review.
- Tell Connor his login is now `connor@marleymoves.co.uk` and confirm passkey/password access.
- Complete real-phone/iPad field checks: installed PWA, mic permission, HEIC/photo, offline completion, and large 4G video.
- Complete card sandbox scenarios when takepayments merchant credentials arrive; leave the feature switch off until then.
- Confirm contractor/IR35/accounting gates before the first real contractor pay run.
- Decide/execute the content publishing phase separately; the capture/review system is release-ready, publishing is not part of this release.
- Follow the fresh-start cutover order in `docs/go-live-test-plan.md`; only then remove `SANITY_SYNC_DISABLED`, backfill approved open work and set `COMMS_DRYRUN=false`.

## Final recommendation

Merge and release the code/migration as one unit, then hold the data/comms switches until the human checklist is signed. Do not deploy the application changes without migration 0069: the app-side assignment checks improve safety, but the migration is the database authorization boundary that closes direct PostgREST access.
