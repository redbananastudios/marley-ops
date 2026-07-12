# Premium role-based UI and workflow handoff

Updated: 12 July 2026 (late evening — rollout pass 3 complete)
Status: checkpoint browser-accepted at all three role viewports; QA fixes + rollout passes 1–3 committed (`1fe1be4` … `83b88b0`); production `npm run build` green, 278 tests + tsc green. **The whole "Remaining" list is now done** — only explicitly out-of-scope items are left (customer-facing routes, a separate pre-existing-lint cleanup).

## Rollout pass 3 (12 Jul, committed 83b88b0) — tab/filter vocabulary

The last substantive item. Four switcher idioms (Radix underline, red-tint segmented, solid-red pill tabs, red-tint chips) with **red on every active state** were consolidated into one calm vocabulary in `components/ui/segmented.tsx`:
- `segmentedTrackClass` + `segmentedItemClass` (iOS/Vercel muted-rail + white active pill) → Dashboard period, Performance tabs + Sales range, Documents tabs, Clients Grid/List, Resources Staff/Vehicles.
- `filterChipClass` + count badge (calm grey active fill) → Quotes + Leads presets.
- Lead-detail keeps the shared Radix underline `Tabs` (the distinct "sub-nav within a record" affordance).

Red is now removed from every tab/filter and reserved for primary CTAs + the sidebar's active marker (the stated design rule). All six surfaces browser-verified.

## Rollout pass 2 (12 Jul, committed f348fd2 → ec9e891)

- **Brand lockup redone** (`f348fd2`): the menu logo (Peter: "looks poor") is now the **official full-colour Marley brandmark** (`logos/…/Brandmark - Full-Colour`, 500×500 transparent) in a clean white rounded app-tile (hairline ring + soft shadow), with the **"MARLEY OPS" wordmark in Cormorant Garamond** — the Marley Moves website heading face, loaded via `next/font` (`--font-cormorant` / `--font-brand` token + `.font-brand`). Geist stays the UI face everywhere else. Shared `BrandMark` covers sidebar, mobile header, drawer and both crew headers.
- **Crew sticky cab bar** (`3dc6efe`): fixed bottom bar on the crew job sheet — Directions (to pickup), Call <customer>, and the next state action (Complete job) as the dominant slot; safe-area padded; Job sheet PDF stays in the header row. `CompleteJobButton` gained `triggerClassName`.
- **Persistent autosave feedback** (`19978cc`): quote + cubic builders now show spinner→green-check "All changes saved" (aria-live) in the always-on-screen sticky bar. Also fixed the quote bottom-bar offset (`md:left-60` → `xl:left-64`, matching the redesigned sidebar).
- **Colour vocabulary calmed** (`8816a36`): lead-card action tray (5-colour rainbow) and client contact icons neutralised to grey with hover-to-foreground; semantic intent survives on hover only. Labels/tooltips were already present. Status chips keep their semantic tint (information, not decoration).
- **Bookings shell aligned** (`ec9e891`): dropped the lone `mx-auto max-w-5xl` container for the shared `flex-1 p-6 md:p-8`.
- **Interaction QA pass:** focus rings visible on keyboard focus (2px), no horizontal overflow at 768, dialogs open/close cleanly (survey, complete-job, cubic add all verified), zero runtime console errors on fresh loads. No defects found.

## Browser QA result (12 Jul, local Supabase stack)

## Browser QA result (12 Jul, local Supabase stack)

All acceptance checks below passed at desktop 1440×1000 (office), iPad 768×1024 + 1024×1366 (estimator) and phone 390×844 (crew): single black nav state everywhere, Geist rendered including menu labels, drawer (no gutter) on tablet, Create → all three workflows, `?new=1` opens/closes the survey dialog cleanly, estimator lands on My day with survey cards (Call / Open lead / Start survey), lead guidance flips Call → Book survey after contact, crew list/detail one-handed with no horizontal overflow, zero app console errors.

Fixed during QA (commit `1fe1be4`): thin dark nav scrollbar; `?new=1`/`?leadId` stripped on dialog close (refresh no longer reopens); crew job-sheet header duplication + dash-placeholder addresses; **Peter (live feedback): sharper menu icons (16px stroke-2, borderless plates) + Marley brand mark in a white tile beside "Marley Ops" on every black rail**.

Rollout pass 1 (commit `b196497`): crew headers share BrandMark; shared `components/ui/empty-state.tsx` applied to Follow-ups + Quotes; "Pipeline Board" title matches nav; one pre-existing purity lint error fixed in quotes-view.

Environment notes for the next session:
- Local Supabase stack (`supabase_*_marley-ops` Docker) with seeded users `*@marleymoves.test` / password `MarleyOps!2026` (see `scripts/seed-dev.mjs`).
- **Dev fixtures left in place** (script-backed via `scripts/seed-dev-crew.mjs`, so the crew + estimator surfaces are immediately reviewable): crew login `crew@marleymoves.test`, staff "Jack Reed (Dev)", vehicle "Luton 1 (Dev)", a removal today assigned to that crew ("Removal — Jane Hooper"), and a Connor survey today ("Survey — Priya Patel"). The incidental QA artifacts (a draft quote + a cubic survey from click-testing) were removed, so quotes/cubic tables are back to empty.
- `SANITY_SYNC_DISABLED=true` is set in the worktree `.env.local` and a real website lead (real PII, auto-synced from prod Sanity on dashboard load) was deleted from the local DB. **Keep the flag set** — QA against real customers is the failure mode.
- Turbopack served stale `globals.css` / imports after an edit a couple of times — if a CSS/import change doesn't appear (or you see a transient `X is not defined`), restart the dev server; it clears.

## Remaining (all out-of-scope by design)

- **Customer-facing routes** (`/q`, `/cv`, `/s`) deliberately untouched — these are live customer surfaces; restyling them needs a separate decision from Peter before touching.
- **Pre-existing lint cleanup**: repo-wide lint is red from React-Compiler debt that predates this branch (set-state-in-effect hydration patterns in a few views, a couple of `Date.now()`-in-render). This branch introduced **zero** new lint failures and cleared the two it touched incidentally; a dedicated lint-cleanup pass is warranted but is its own piece of work.
- **Optional nicety**: a handful of bespoke inline empty states (board columns, bookings sections) could adopt the shared `EmptyState`, but they read fine in context — diminishing returns.

Everything else on the original "Remaining" list — crew cab bar, autosave feedback, colour calm, Bookings shell, tab/filter vocabulary — is **done** (passes 1–3).

## Outcome being built

Marley Ops should feel like a premium, fast operational tool in which the next action is obvious. The interface must reduce thought and navigation for each role:

- Office and admin staff work mainly from a desktop dashboard and need the full operational picture.
- Estimators work mainly on iPad or similar tablets and need a focused day view, rapid lead follow-up, surveys, and quotes.
- Crew work mainly on phones and tablets and need only their assigned jobs, job details, and clear on-site actions.
- The core commercial path must read naturally as **create lead -> contact customer -> book survey -> complete survey -> create quote -> book job**.

This is not yet a completed whole-system redesign. The first shared-shell and role-workflow checkpoint is implemented and verified at code/test level. It still needs visual browser acceptance testing, refinement, and application across every remaining route listed below.

## Approved visual direction

Treat this section as authoritative if temporary reference images disappear.

- Use exactly one expanded black/charcoal desktop sidebar. Never render a collapsed rail and expanded menu at the same time.
- Use Geist Sans throughout, including the menu: `"GeistSans", "GeistSans Fallback"`.
- Use coherent premium line icons in restrained two-tone icon plates. Do not use emoji or mix unrelated icon weights/styles.
- Use Marley red `#C03838` as the decisive action and active-state accent.
- Use a pale mineral-grey application canvas, white panels, fine cool-grey borders, restrained shadows, and generous but efficient spacing.
- Use semantic accents sparingly: red for urgent/primary, blue for contacted/information, teal for surveys, green for won/completed, amber for waiting/time, violet only where it improves category recognition.
- Prefer large, obvious touch targets and short action labels on iPad/mobile.
- Avoid decorative complexity, excessive gradients, glass effects, or colour everywhere. The intended quality is modern, calm, and operational.

The two user-favoured references supplied during the design discussion were:

- `C:\Users\peter\AppData\Local\Temp\codex-clipboard-6530be22-fa41-414d-9192-065a6c30309d.png`
- `C:\Users\peter\AppData\Local\Temp\codex-clipboard-860892fd-b230-456d-83c5-feb1f59f515c.png`

They are temporary files and must not be treated as durable project assets. The first showed the desired restrained desktop density; the second established the preferred black navigation direction. Later generated concepts accidentally showed both menu states simultaneously; that is explicitly rejected.

## Git and workspace state

- Primary checkout: `O:\projects\red-banana\clients\marley\marley-ops`
- Dedicated worktree: `O:\projects\red-banana\clients\marley\marley-ops-ui-workflows`
- Branch: `codex/premium-role-ui`
- Base: `origin/master` at `ed8df2b`
- Other live worktree which must not be changed: `O:\projects\red-banana\clients\marley\marley-ops-ai-surveyor`, branch `codex/ai-survey-field-rollout`
- Never continue this work in the primary checkout. Work only in the dedicated worktree above.
- `.env.local` was copied into the worktree for local verification and must remain untracked.
- Dependencies were installed with `npm ci`.
- Nothing from this branch has been pushed or deployed at this checkpoint.

## Implemented in this checkpoint

### Shared visual foundation

- `app/globals.css`: mineral-grey canvas, black-sidebar tokens, operational semantic colours, Geist font features, a capped `page-shell`, and a `content-auto` performance helper.
- `components/ui/card.tsx`: premium rounded cards with fine borders and restrained shadow.
- `components/ui/button.tsx`: larger default touch targets.
- `components/ui/tabs.tsx`: clearer red active state.
- `components/page-header.tsx`: stronger responsive hierarchy.
- `components/ui/icon-badge.tsx`: shared premium semantic icon tiles.

### Role-aware navigation and creation

- `components/app-sidebar.tsx`: rebuilt as one expanded black desktop sidebar, shown from `xl` upward. It no longer maintains or renders a collapsed state.
- Admin/office receives the full navigation. Estimator receives the reduced operational set: My day, Leads, Follow-ups, Surveys, and Quotes.
- `components/mobile-nav.tsx`: black sticky tablet/mobile header and drawer with role-specific navigation.
- `components/quick-create.tsx`: persistent Create menu with direct actions for New lead, Book survey, and New quote.
- Survey creation links to `/schedule/surveys?new=1`; the survey screen now opens its scheduling dialog from that query parameter.

### Office/admin dashboard

- `components/dashboard/dashboard-view.tsx`: premium KPI icon system and colour rails, improved page/header/tabs, and conversion rings that stack cleanly on phones instead of being squeezed into three columns.
- Office/admin users continue to land on the main analytics dashboard.

### Estimator workflow

- `app/(dashboard)/page.tsx`: estimator users are redirected from the generic dashboard to `/estimator`.
- `app/(dashboard)/estimator/page.tsx`: new mobile-first My day workspace with one-tap New lead, Book survey, and New quote; today's assigned surveys; Call, Open lead, and Start AI survey actions; and active assigned leads.
- `components/leads/lead-action-bar.tsx`: now explains the recommended next step. An uncontacted lead presents Call customer before Book survey; survey booking appears after contact so the workflow is sequential and obvious.
- `lib/auth.ts`: session profile reads are wrapped in React `cache()` to deduplicate layout/page authentication work during one render.

### Crew workflow

- `app/my-jobs/page.tsx`: black sticky crew header, improved mobile spacing, and clearer move/survey job cards.
- `app/my-jobs/[id]/page.tsx`: matching black sticky header, premium job summary, and improved small-screen spacing.

## Verification completed

- Baseline before implementation: `npm test` passed 29 files and 278 tests.
- After implementation: `npm test` passed 29 files and 278 tests.
- After implementation: `npm run typecheck` passed.
- Targeted ESLint passed for the new and directly changed role/navigation/workflow files.
- `npm ci` reported two moderate dependency vulnerabilities. They were not auto-fixed because `npm audit fix --force` could introduce breaking dependency changes.

The repository-wide `npm run lint` was already red before this work: 26 errors and 6 warnings, mainly React Compiler purity/static-component/set-state-in-effect rules plus explicit `any` in tests. Do not claim full lint is green, and do not make unrelated bulk lint repairs part of this UI branch unless separately agreed. The rule for this branch is to introduce no new lint failures and fix issues in files being directly changed where practical.

Vitest touched `tests/lib/quote/__snapshots__/pricing.test.ts.snap` in the worktree status, but its worktree and `HEAD` blob hashes were identical and `git diff` was empty. Do not stage that file.

## Required next work

### 1. Browser acceptance test this checkpoint

Start the server only after allocating a registered port:

```powershell
$port = & "O:\RBS-OS\scripts\port-alloc.ps1" alloc -Project "marley-ops" -App role-ui -Stack next -Quiet
npm run dev -- --port $port
```

The package's dev command already binds to `0.0.0.0`. Report the preview as `http://i9:<port>`.

Use Playwright and store all screenshots outside the repo, for example under `$env:TEMP\marley-ops-ui-qa`. Clean those temporary captures when the comparison is complete.

Test at minimum:

- Desktop office/admin: 1440 x 1000.
- iPad portrait and landscape estimator: 768 x 1024 and 1024 x 1366.
- Phone crew: 390 x 844.

Acceptance checks:

- Exactly one black navigation state is visible at every breakpoint.
- Geist Sans is actually rendered, including menu labels.
- Desktop navigation remains expanded and readable; tablet uses the drawer and does not reserve an empty sidebar gutter.
- Create -> New lead, Book survey, and New quote reach the intended workflows.
- `/schedule/surveys?new=1` opens the schedule dialog immediately and closes cleanly without reopening.
- Estimator login/role routing lands on My day and shows correct assigned data.
- Lead action guidance changes correctly after contact and survey state changes.
- Crew job list/detail work one-handed, use large touch targets, and have no horizontal overflow.
- Compare screenshots to the approved direction above; code-level correctness is not visual acceptance.

### 2. Apply the system across every remaining workflow

Inspect each route in a real browser and bring it into the same visual and interaction system. Do not declare the redesign complete until each is checked:

- Leads: board/list, create form, detail, contact, survey transition, empty/loading/error states.
- Follow-ups and communications.
- Clients and client detail.
- Pipeline Board.
- Surveys calendar, survey forms, AI survey capture, processing/review, and handoff.
- Removals calendar and removal/job detail.
- Job Board, staff/fleet assignment, resources, and storage.
- Quotes list, new quote/builder, review/send/accept flow, and tablet usability.
- Bookings and booking conversion.
- Documents.
- Performance/reports.
- Settings and account/role administration.
- Crew and any customer-facing/public routes.

For each workflow, check desktop, iPad, phone where relevant; keyboard focus; touch sizes; empty states; loading feedback; errors; destructive-action confirmation; and whether the next primary action is unambiguous.

### 3. Workflow refinements likely worth implementing

- Make the quote builder and AI survey review deliberately iPad-first, with a persistent progress indicator, one dominant Continue action, and safe auto-save feedback.
- Consider a sticky bottom action bar on crew job details for the next job-state action, call, and directions.
- Apply the existing `content-auto` helper to genuinely long below-the-fold grids/lists after browser measurement; do not apply it blindly to interactive elements whose dimensions affect scrolling.
- Reduce unnecessary client work and data duplication route by route. Prefer server-rendered summaries, cached/deduplicated session reads, paginated/virtualised long lists, and lightweight skeletons. Measure before claiming a speed improvement.
- Build a shared status/badge/action vocabulary instead of letting each screen invent colours and wording.
- Keep navigation grouped by role and task frequency rather than database entities. Rare admin/configuration actions should not compete with Create lead, Book survey, New quote, or today's work.

## Safe continuation sequence

1. Read this document and `CLAUDE.md` from the dedicated worktree.
2. Run `git status --short --branch` and confirm the branch/worktree above.
3. Run the existing test/typecheck baseline before further edits.
4. Allocate a port, start the app, and complete screenshot-based acceptance testing.
5. Fix checkpoint issues found in the browser before widening scope.
6. Work through the remaining route inventory in role-priority order: estimator survey/quote, crew job execution, then office pipeline/admin surfaces.
7. Run targeted lint on every touched file, `npm run typecheck`, and `npm test` at each logical checkpoint.
8. Commit small logical units, staging only files deliberately changed. Never stage the status-only quote snapshot.
9. Do not push, deploy, merge, or remove worktrees without the appropriate authorization and final verification.

## Definition of done

The initiative is complete only when:

- Every in-scope route has been visually inspected and reconciled with the shared system.
- Office, estimator, and crew each see task-appropriate navigation and landing experiences.
- Lead -> contact -> survey -> quote -> booking is obvious without prior training.
- The black menu never displays expanded and collapsed states together.
- Geist Sans and the icon system are consistent across the application.
- Desktop, iPad, and phone acceptance screenshots pass comparison.
- Tests and typecheck pass; touched files pass lint; no new console/runtime/accessibility errors remain.
- The branch has a reviewable commit history and the final state is documented before merge/deploy.
