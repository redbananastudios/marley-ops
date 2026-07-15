/**
 * Thin wrapper over the `web-push` library — the DI seam the sender uses so
 * tests exercise fan-out/error handling against a fake transport and never
 * touch a real push service (PRD §20.2).
 *
 * VAPID configuration is validated lazily on first send: the app must boot
 * (and every non-push feature must work) even when the keys are absent —
 * push simply reports itself unconfigured.
 */

import webpush from "web-push";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSendResult =
  | { ok: true; status: number }
  | { ok: false; kind: "gone" | "transient" | "permanent"; status: number | null; error: string };

export type PushTransport = (
  target: PushTarget,
  payload: string,
  opts: { ttlSeconds: number; urgency: "normal" | "high" },
) => Promise<PushSendResult>;

export function vapidConfigured(): boolean {
  return Boolean(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY &&
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
      process.env.WEB_PUSH_VAPID_SUBJECT,
  );
}

export function vapidPublicKey(): string | null {
  return process.env.WEB_PUSH_VAPID_PUBLIC_KEY || null;
}

let vapidApplied = false;

/** Classify a web-push failure (PRD §12.2): 404/410 = subscription gone
 *  (prune), 429/5xx/network = transient, other 4xx = permanent. */
export function classifyPushError(status: number | null): "gone" | "transient" | "permanent" {
  if (status === 404 || status === 410) return "gone";
  if (status === null || status === 429 || status >= 500) return "transient";
  return "permanent";
}

export const realPushTransport: PushTransport = async (target, payload, opts) => {
  if (!vapidConfigured()) {
    return { ok: false, kind: "permanent", status: null, error: "VAPID keys not configured" };
  }
  if (!vapidApplied) {
    webpush.setVapidDetails(
      process.env.WEB_PUSH_VAPID_SUBJECT!,
      process.env.WEB_PUSH_VAPID_PUBLIC_KEY!,
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY!,
    );
    vapidApplied = true;
  }
  try {
    const res = await webpush.sendNotification(target, payload, {
      TTL: opts.ttlSeconds,
      urgency: opts.urgency,
    });
    return { ok: true, status: res.statusCode };
  } catch (err) {
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? ((err as { statusCode: number }).statusCode)
        : null;
    return {
      ok: false,
      kind: classifyPushError(status),
      status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
