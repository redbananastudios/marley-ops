/**
 * Client-side push helpers — pure logic only (tested), no React. The browser
 * IO lives in components/push/notifications-setup.tsx.
 */

/** VAPID application server key: URL-safe base64 → Uint8Array for
 *  pushManager.subscribe() (the one conversion everyone gets wrong). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/** The states the settings UI must distinguish (PRD §16.2). */
export type PushUiState =
  | "unsupported"
  | "install_required"
  | "admin_disabled"
  | "blocked"
  | "available"
  | "enabled"
  | "needs_repair";

export interface PushEnvironment {
  /** navigator.serviceWorker && PushManager && Notification all present. */
  supported: boolean;
  /** iOS/iPadOS Safari NOT running as an installed Home Screen app — push is
   *  impossible there until the user installs (PRD §9). NOTE: on those
   *  devices the push APIs are hidden too, so this must be evaluated
   *  independently of (and take precedence over) `supported`. */
  installRequired: boolean;
  /** business_settings.push_enabled from the server. */
  systemEnabled: boolean;
  permission: NotificationPermission | "unknown";
  /** A live browser subscription exists for this installation. */
  hasSubscription: boolean;
  /** The server acknowledged/holds this subscription. */
  serverRegistered: boolean;
}

export function derivePushUiState(env: PushEnvironment): PushUiState {
  // install_required MUST beat unsupported: an iOS Safari TAB hides the push
  // APIs entirely (supported=false), but the right answer there is "install
  // to Home Screen", not "unsupported" — the APIs appear once installed.
  if (env.installRequired) return "install_required";
  if (!env.supported) return "unsupported";
  if (!env.systemEnabled) return "admin_disabled";
  if (env.permission === "denied") return "blocked";
  if (env.permission === "granted" && env.hasSubscription && env.serverRegistered) return "enabled";
  if (env.permission === "granted" && env.hasSubscription && !env.serverRegistered) return "needs_repair";
  return "available";
}

/** iOS/iPadOS needs Add-to-Home-Screen before push exists. Detection is the
 *  documented pragmatic pair: Apple touch device + not in standalone display
 *  mode. Everything else (incl. iPad "desktop mode" Safari) that lacks
 *  PushManager falls out as unsupported instead. */
export function detectInstallRequired(nav: {
  userAgent: string;
  standalone: boolean;
  maxTouchPoints: number;
}): boolean {
  const appleMobile =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    // iPadOS 13+ masquerades as macOS but reports touch points.
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  return appleMobile && !nav.standalone;
}

/** Stable per-browser-installation id (NOT a hardware id) — lets the server
 *  tell two devices of one user apart. */
export const INSTALLATION_ID_KEY = "mm-push-installation-id";

export function getOrCreateInstallationId(storage: Pick<Storage, "getItem" | "setItem">): string {
  const existing = storage.getItem(INSTALLATION_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const id = crypto.randomUUID();
  storage.setItem(INSTALLATION_ID_KEY, id);
  return id;
}
