/**
 * PWA read-caching rules — the single source of truth for WHAT the service
 * worker caches and under which strategy. public/sw.js is a plain script (no
 * imports), so these constants + predicates are DUPLICATED there and pinned by
 * tests/lib/pwa/cache-rules.test.ts. Change BOTH or neither (same discipline as
 * lib/push/payload.ts ↔ sw.js).
 *
 * Design (deliberate — the SW was push-only by choice):
 *  - Crew job documents (/my-jobs*) are NETWORK-FIRST: online always shows live
 *    server data; offline falls back to the last copy cached on a good load, so
 *    a crew member on Blackmore-Vale signal can still read their jobs.
 *  - Immutable, content-hashed build assets (/_next/static/*) are CACHE-FIRST —
 *    the URL changes every build, so a cached copy can never be stale. This is
 *    what lets the offline document actually render (CSS + JS present).
 *  - Everything else (APIs, RSC payloads, auth, /_next/data, images) is left
 *    UNTOUCHED — served live exactly as before. No stale bundles, no stale
 *    authenticated data.
 */

export const CACHE_VERSION = "v1";
export const JOBS_DOC_CACHE = `mo-jobs-docs-${CACHE_VERSION}`;
export const STATIC_CACHE = `mo-static-${CACHE_VERSION}`;
/** Branded static fallback shown when a job doc is requested offline and nothing
 *  is cached yet (first-ever visit made offline). Precached on SW install. */
export const OFFLINE_URL = "/offline.html";
/** Caches this SW owns — activate() deletes any other `mo-*` cache. */
export const MANAGED_CACHES = [JOBS_DOC_CACHE, STATIC_CACHE];
/** Header a background warm request sets so the SW caches a programmatic (non
 *  navigation) fetch of a job doc. */
export const WARM_HEADER = "x-mo-warm";
/** Cap cached job docs / static assets (FIFO) so an install doesn't grow without
 *  bound across months of deploys. */
export const MAX_JOB_DOCS = 30;
// Comfortably larger than one build's whole client-asset set: a cached job doc
// (always the latest build) references this build's hashed chunks, and FIFO
// eviction must never drop a chunk the current cached doc still needs.
export const MAX_STATIC = 400;

/** A crew job document we network-first cache for offline reading. */
export function isCrewJobDoc(pathname: string): boolean {
  return pathname === "/my-jobs" || pathname.startsWith("/my-jobs/");
}

/** An immutable, content-hashed build asset — safe to cache-first forever. */
export function isImmutableAsset(pathname: string): boolean {
  return pathname.startsWith("/_next/static/");
}
