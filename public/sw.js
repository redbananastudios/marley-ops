/**
 * Marley Ops service worker — Web Push + a SCOPED crew read-cache (v2).
 *
 * The read-cache is the offline shell "designed on purpose" the v1 note asked
 * for (crew-reliability PRD A2). It is deliberately narrow:
 *  - Crew job documents (/my-jobs*) → NETWORK-FIRST: online always live; offline
 *    falls back to the last good copy so a crew member with no signal can read
 *    their jobs.
 *  - Immutable, content-hashed build assets (/_next/static/*) → CACHE-FIRST (the
 *    URL changes every build, so a cached copy can't be stale) — this is what
 *    lets the offline document actually render.
 *  - Everything else (APIs, RSC, auth, /_next/data, images) is UNTOUCHED, served
 *    live exactly as the push-only v1 did. No stale bundles, no stale auth data.
 *
 * Two contracts are DUPLICATED here because this is a plain script (no imports):
 *  - push payload + deep-link allowlist ↔ lib/push/payload.ts (tests/lib/push/payload.test.ts)
 *  - cache rules ↔ lib/pwa/cache-rules.ts (tests/lib/pwa/cache-rules.test.ts)
 * Change BOTH or neither.
 */

const ICON = "/icons/icon-192.png";
const FALLBACK_TITLE = "Marley Ops";
const FALLBACK_BODY = "You have a new update.";

// ── Read-cache rules (mirror lib/pwa/cache-rules.ts) ──────────────────────────
const JOBS_DOC_CACHE = "mo-jobs-docs-v1";
const STATIC_CACHE = "mo-static-v1";
const ALERT_LEDGER_CACHE = "mo-alert-ledger-v1";
const ALERT_MARKER_PATH = "/__marley-ops/new-enquiry-notified";
const OFFLINE_URL = "/offline.html";
const MANAGED_CACHES = [JOBS_DOC_CACHE, STATIC_CACHE, ALERT_LEDGER_CACHE];
const WARM_HEADER = "x-mo-warm";
const MAX_JOB_DOCS = 30;
// Generous: a cached /my-jobs document (network-first, always the latest build)
// links this build's hashed chunks. FIFO evicts OLDEST first (older builds), but
// the cap must comfortably exceed one build's whole client-asset set so a chunk
// the current cached document still needs is never evicted. Old-build assets are
// also purged on activate() when CACHE_VERSION bumps.
const MAX_STATIC = 400;

function isCrewJobDoc(pathname) {
  return pathname === "/my-jobs" || pathname.startsWith("/my-jobs/");
}
function isImmutableAsset(pathname) {
  return pathname.startsWith("/_next/static/");
}

async function requestAudioClaim(client, category, tag) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (claimed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(claimed === true);
    };
    const timer = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = (event) => finish(event.data && event.data.claimed === true);
    try {
      client.postMessage({ type: "mm-audio-claim", category, tag }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

async function rememberOsEnquiryNotification() {
  try {
    const cache = await caches.open(ALERT_LEDGER_CACHE);
    await cache.put(
      ALERT_MARKER_PATH,
      new Response(String(Date.now()), { headers: { "content-type": "text/plain" } }),
    );
  } catch {
    // Dedupe is best-effort; never interfere with the notification itself.
  }
}

// FIFO trim so an install doesn't grow without bound over months of deploys.
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const req of keys.slice(0, keys.length - max)) await cache.delete(req);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok && res.type === "basic") {
    // Keep the worker alive until the cache mutation finishes. Cache failures
    // stay fail-soft: the successful network response still wins.
    try {
      await cache.put(request, res.clone());
      await trimCache(STATIC_CACHE, MAX_STATIC);
    } catch {
      // best-effort read cache
    }
  }
  return res;
}

async function networkFirstDoc(request) {
  const cache = await caches.open(JOBS_DOC_CACHE);
  try {
    const res = await fetch(request);
    // Only cache a real, successful, same-origin document (never a redirect to
    // /login — that would pin a signed-out shell as the crew's "jobs").
    if (res && res.ok && res.type === "basic" && !res.redirected) {
      try {
        await cache.put(request, res.clone());
        await trimCache(JOBS_DOC_CACHE, MAX_JOB_DOCS);
      } catch {
        // best-effort read cache; keep serving the live document
      }
    }
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

// Keep in sync with ALLOWED_ROUTE_PREFIXES in lib/push/payload.ts.
const ALLOWED_ROUTE_PREFIXES = [
  "/leads",
  "/quotes",
  "/bookings",
  "/payments",
  "/follow-ups",
  "/clients",
  "/documents",
  "/jobs",
  "/schedule",
  "/my-jobs",
  "/settings",
  "/storage",
  "/resources",
  "/performance",
];

function isAllowedRoute(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return false;
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  if (url.includes("\\") || url.includes(":")) return false;
  if (url === "/") return true;
  return ALLOWED_ROUTE_PREFIXES.some(
    (p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"),
  );
}

self.addEventListener("install", (event) => {
  // Precache the offline fallback so a first-ever visit made offline still lands
  // on a branded page. Best-effort — a failed precache never blocks install.
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.add(OFFLINE_URL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any of OUR caches from an older version; leave everything else.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("mo-") && !MANAGED_CACHES.includes(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Immutable build assets → cache-first (safe: hashed URL, never stale).
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Crew job documents → network-first with an offline fallback. Covers a real
  // navigation (PWA relaunch / refresh) and an explicit background warm request.
  const isWarm = req.headers.get(WARM_HEADER) === "1";
  if (isCrewJobDoc(url.pathname) && (req.mode === "navigate" || isWarm)) {
    event.respondWith(networkFirstDoc(req));
    return;
  }

  // Everything else is served live, untouched — as the push-only worker did.
});

// Sign-out (and any caller) can wipe the crew read-cache off a shared device.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "mm-clear-cache") {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("mo-")).map((n) => caches.delete(n)))),
    );
  }
});

self.addEventListener("push", (event) => {
  // Parse defensively — a malformed payload still shows a safe generic
  // notification rather than silently dropping (or crashing the worker).
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }

  const title =
    data && typeof data.title === "string" && data.title.trim() ? data.title : FALLBACK_TITLE;
  const body = data && typeof data.body === "string" ? data.body : FALLBACK_BODY;
  const tag = data && typeof data.tag === "string" && data.tag ? data.tag : undefined;
  const url = data && isAllowedRoute(data.url) ? data.url : "/";
  const suppressWhenFocused = Boolean(data && data.suppressWhenFocused === true);
  const category = data && typeof data.category === "string" ? data.category : "unknown";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      // A focused page owns the alert only after it confirms the chime really
      // started. A suspended AudioContext declines, preserving the reliable OS
      // notification fallback for a newly launched desktop PWA.
      const focusedClient = windows.find((c) => c.focused);
      if (suppressWhenFocused && focusedClient) {
        const claimed = await requestAudioClaim(focusedClient, category, tag);
        if (claimed) return;
      }

      await self.registration.showNotification(title, {
        body,
        icon: ICON,
        badge: ICON,
        tag,
        // Tag replacement is silent by default — but our replacements carry
        // NEW news (e.g. "taken off the job" replacing "new job for you"),
        // so they must buzz again. Ignored where unsupported.
        renotify: Boolean(tag),
        data: { url },
      });

      if (category === "new_enquiry") await rememberOsEnquiryNotification();

      // Refresh open app windows only after the OS-alert marker is durable.
      for (const client of windows) {
        try {
          client.postMessage({ type: "mm-push", category, tag });
        } catch {
          // best-effort
        }
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const url = isAllowedRoute(raw) ? raw : "/";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer focusing an existing Marley Ops window, navigated to the target.
      for (const client of windows) {
        if (!("focus" in client)) continue;
        try {
          await client.focus();
        } catch {
          continue; // couldn't focus this one — try the next
        }
        // Focused: we're DONE even if navigation fails (an uncontrolled
        // client rejects navigate()) — opening a second window on top of a
        // focused one is worse than landing on the wrong page.
        try {
          if ("navigate" in client) await client.navigate(url);
        } catch {
          /* stay on the focused window */
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
