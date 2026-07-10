/**
 * Digital signatures — shared constants + pure validation (Peter, 2026-07-10).
 * Three signature moments only: contract (at /q acceptance, or in person on
 * the crew tablet), completion sign-off (customer + crew lead), and the
 * storage agreement (billing phase 2). Signatures are simple e-signatures
 * (typed name or finger-drawn) — valid under UK eIDAS; the value is the
 * evidence pack: who/what-version/when/how, kept in the signatures table.
 */

/** Bump when the published T&Cs change. GENERIC terms at launch — legal
 *  review before full go-live is tracked in ClickUp 869e35z42. */
export const TERMS_VERSION = "generic-v1-2026-07-10";

export const TERMS_URL = "https://marleymoves.co.uk/terms-conditions/";

/** The contract acknowledgments — one signature, several protections. Shown
 *  as tick-boxes on /q AND on the in-person crew-tablet flow (identical
 *  record either way). Keys are stored in signatures.acknowledgments. */
export const CONTRACT_ACKS = [
  {
    key: "inventory",
    label: "The move details and inventory in my quote are complete and correct.",
  },
  {
    key: "owner_packed",
    label: "I understand items in boxes I pack myself are not covered for breakage.",
  },
  {
    key: "no_hazardous",
    label: "My belongings include no hazardous items (fuel, gas bottles, paint, chemicals).",
  },
] as const;

export type ContractAckKey = (typeof CONTRACT_ACKS)[number]["key"];

/** All acknowledgments ticked? (Object shape: { inventory: true, ... }) */
export function allAcksConfirmed(acks: Record<string, unknown> | null | undefined): boolean {
  if (!acks) return false;
  return CONTRACT_ACKS.every((a) => acks[a.key] === true);
}

/** Normalise a client-sent acks object to exactly the known keys. */
export function normalizeAcks(acks: Record<string, unknown> | null | undefined): Record<ContractAckKey, boolean> {
  const out = {} as Record<ContractAckKey, boolean>;
  for (const a of CONTRACT_ACKS) out[a.key] = acks?.[a.key] === true;
  return out;
}

// A finger-drawn signature lands as a PNG data URI. Bounds: an empty canvas
// export is ~1-2KB (we also reject "nothing drawn" client-side); a dense
// signature stays well under 200KB.
const SIG_PREFIX = "data:image/png;base64,";
export const SIG_MAX_BYTES = 200_000;
const SIG_MIN_CHARS = 500;

export function isValidSignatureDataUri(s: unknown): s is string {
  if (typeof s !== "string" || !s.startsWith(SIG_PREFIX)) return false;
  const b64 = s.slice(SIG_PREFIX.length);
  if (b64.length < SIG_MIN_CHARS) return false; // too small to be a real signature
  if (b64.length * 0.75 > SIG_MAX_BYTES) return false;
  return /^[A-Za-z0-9+/=]+$/.test(b64);
}

/** Human line for activity logs / certificates: "signed in person on our tablet". */
export function channelLabel(channel: string): string {
  return channel === "in_person" ? "in person on our device" : "online";
}
