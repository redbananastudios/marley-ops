/**
 * The route surface, per role — the backbone of the access/gating coverage.
 * Every nav destination plus the reachable static routes. Deep id routes
 * (/leads/[id], /quotes/[id], …) are covered by the feature specs that seed
 * the id, not by the static access matrix.
 */

/** Office/admin nav (components/app-sidebar OFFICE_NAV) + reachable statics. */
export const OFFICE_ROUTES = [
  "/",
  "/leads",
  "/leads/new",
  "/follow-ups",
  "/board",
  "/quotes",
  "/quotes/new",
  "/bookings",
  "/payments",
  "/finance",
  "/finance/statements",
  "/schedule/surveys",
  "/schedule/removals",
  "/jobs",
  "/clients",
  "/documents",
  "/claims",
  "/content",
  "/resources",
  "/storage",
  "/performance",
  "/automations",
  "/settings",
  "/manual",
] as const;

/** Estimator nav (ESTIMATOR_NAV) — every page an estimator is meant to reach. */
export const ESTIMATOR_ROUTES = [
  "/estimator",
  "/leads",
  "/follow-ups",
  "/schedule/surveys",
  "/quotes",
  "/quotes/new",
  "/bookings",
  "/payments",
  "/estimator/pay",
  "/settings",
  "/manual",
] as const;

/** Crew lives entirely under /my-jobs. */
export const CREW_ROUTES = [
  "/my-jobs",
  "/my-jobs/availability",
  "/my-jobs/agreement",
  "/my-jobs/hours",
  "/my-jobs/pay",
  "/my-jobs/manual",
] as const;

/** Dashboard routes a crew member must be bounced OFF (never see office data). */
export const CREW_FORBIDDEN = [
  "/",
  "/leads",
  "/quotes",
  "/finance",
  "/board",
  "/clients",
  "/settings",
  "/resources",
  "/storage",
  "/performance",
] as const;

/**
 * There is deliberately NO ESTIMATOR_FORBIDDEN list here. estimator/gating.spec.ts
 * holds the admin-only route set inline and asserts every entry unskipped, so add
 * a newly gated route THERE — a second copy in this file would be imported by
 * nothing, and the one that lived here until 2026-09-02 had drifted to describe
 * seven routes as ungated and skipped long after QA-20260827-01 was fixed. A list
 * beside CREW_FORBIDDEN reads as iterated somewhere; this one never was, so a
 * route added to it would simply not have been checked.
 */
