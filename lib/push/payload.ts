/**
 * The wire contract between the server sender and public/sw.js (pure, tested).
 *
 * The service worker trusts NOTHING: it re-validates shape and the deep link
 * against the same allowlist rules encoded here (sw.js is a plain script and
 * can't import this module, so `isAllowedPushRoute` is duplicated there —
 * tests in tests/lib/push/payload.test.ts pin both to the same behaviour).
 */

import { isPushCategoryId } from "./categories";

export const PUSH_PAYLOAD_VERSION = 1;

export interface PushPayload {
  version: number;
  /** Notification identity — the OS tag. Same tag = replace, not stack. */
  tag: string;
  category: string;
  title: string;
  body: string;
  /** Same-origin relative route (validated by isAllowedPushRoute). */
  url: string;
  /** Skip the OS notification when a Marley Ops window is focused (the in-app
   *  banner/chime owns the moment — new_enquiry conflict rule). */
  suppressWhenFocused: boolean;
  createdAt: string;
}

/**
 * Deep-link allowlist (PRD §11.2): same-origin relative routes only. Blocks
 * external URLs, protocol-relative (`//evil`), schemes (`javascript:`),
 * backslash tricks and anything outside the known app surface.
 */
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

export function isAllowedPushRoute(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return false;
  if (!url.startsWith("/")) return false;
  if (url.startsWith("//")) return false;
  if (url.includes("\\") || url.includes(":")) return false;
  if (url === "/") return true;
  return ALLOWED_ROUTE_PREFIXES.some(
    (p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`),
  );
}

const MAX_TITLE = 80;
const MAX_BODY = 200;
const MAX_TAG = 120;

/** Build the payload string the push service carries (compact, well under the
 *  ~4KB pre-encryption service limits — PRD §19 targets <3KB). */
export function buildPushPayload(fields: {
  tag: string;
  category: string;
  title: string;
  body: string;
  url: string;
  suppressWhenFocused: boolean;
  now: Date;
}): PushPayload {
  return {
    version: PUSH_PAYLOAD_VERSION,
    tag: fields.tag.slice(0, MAX_TAG),
    category: fields.category,
    title: fields.title.slice(0, MAX_TITLE),
    body: fields.body.slice(0, MAX_BODY),
    url: isAllowedPushRoute(fields.url) ? fields.url : "/",
    suppressWhenFocused: fields.suppressWhenFocused,
    createdAt: fields.now.toISOString(),
  };
}

/** Defensive parse for anything claiming to be one of our payloads. */
export function parsePushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.version !== PUSH_PAYLOAD_VERSION) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;
  if (typeof p.body !== "string") return null;
  if (typeof p.tag !== "string" || !p.tag) return null;
  if (typeof p.category !== "string" || !isPushCategoryId(p.category)) return null;
  if (typeof p.url !== "string" || !isAllowedPushRoute(p.url)) return null;
  return {
    version: PUSH_PAYLOAD_VERSION,
    tag: p.tag.slice(0, MAX_TAG),
    category: p.category,
    title: p.title.slice(0, MAX_TITLE),
    body: p.body.slice(0, MAX_BODY),
    url: p.url,
    suppressWhenFocused: p.suppressWhenFocused === true,
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(0).toISOString(),
  };
}
