/**
 * Marley Ops service worker — Web Push only (v1).
 *
 * Deliberately NO fetch/caching handler: the app is online-only today, and a
 * push-only worker means zero risk of serving stale bundles or cached
 * authenticated data (the class of bug that bit the quotes-app PWA). If an
 * offline shell is ever wanted, it gets designed on purpose, not smuggled in.
 *
 * The payload contract + deep-link allowlist mirror lib/push/payload.ts —
 * this file is a plain script (no imports), so the rules are duplicated and
 * pinned by tests/lib/push/payload.test.ts. Change BOTH or neither.
 */

const ICON = "/icons/icon-192.png";
const FALLBACK_TITLE = "Marley Ops";
const FALLBACK_BODY = "You have a new update.";

// Keep in sync with ALLOWED_ROUTE_PREFIXES in lib/push/payload.ts.
const ALLOWED_ROUTE_PREFIXES = [
  "/leads",
  "/quotes",
  "/bookings",
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

self.addEventListener("install", () => {
  // Push-only worker: activate immediately, nothing to precache.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

      // Tell any open app windows so the in-app banner can refresh instantly.
      for (const client of windows) {
        try {
          client.postMessage({ type: "mm-push", category });
        } catch {
          // best-effort
        }
      }

      // Conflict rule (Peter, 2026-07-15): while a Marley Ops window is
      // focused, the in-app banner + chime own new-enquiry alerts — showing
      // the OS notification too would double up. Browsers permit skipping
      // showNotification when the origin has a focused window.
      const hasFocused = windows.some((c) => c.focused || c.visibilityState === "visible");
      if (suppressWhenFocused && hasFocused) return;

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
