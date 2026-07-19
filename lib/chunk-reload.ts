/**
 * Self-hosted skew recovery. Marley Ops runs as a single Next.js standalone
 * container on the OVH box (no Vercel, so no Skew Protection). When a deploy
 * replaces the container, a browser still on the OLD page references
 * /_next/static chunks whose hashes no longer exist — the next client-side
 * navigation throws a ChunkLoadError. The UpdateBanner nudges proactively, but
 * a stale chunk can fail before the 5-min version check fires, so the error
 * boundaries also self-heal: on a chunk error, hard-reload once onto the fresh
 * build. Guarded by a short sessionStorage window so a genuinely broken deploy
 * shows the recover screen instead of reload-looping.
 */

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; message?: string };
  if (e.name === "ChunkLoadError") return true;
  const m = e.message ?? "";
  return /Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    m,
  );
}

const GUARD_KEY = "mm-chunk-reload-at";
const GUARD_WINDOW_MS = 15_000;

/**
 * If `error` is a stale-chunk failure, hard-reload once and return true (the
 * caller should then render a minimal "updating" state, since the page is about
 * to navigate away). No-ops — returns false — for non-chunk errors, or if we
 * already reloaded within the guard window (so a truly broken build surfaces the
 * recover screen rather than looping). Browser-only.
 */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (!isChunkLoadError(error)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(GUARD_KEY) ?? "0");
    const now = Date.now();
    if (Number.isFinite(last) && now - last < GUARD_WINDOW_MS) return false;
    window.sessionStorage.setItem(GUARD_KEY, String(now));
  } catch {
    // sessionStorage blocked (private mode / storage full) — reload anyway once.
  }
  window.location.reload();
  return true;
}
