/**
 * Digital signatures — shared constants + pure validation (Peter, 2026-07-10).
 * Three signature moments only: contract (at /q acceptance, or in person on
 * the crew tablet), completion sign-off (customer + crew lead), and the
 * storage agreement (billing phase 2). Signatures are simple e-signatures
 * (typed name or finger-drawn) — valid under UK eIDAS; the value is the
 * evidence pack: who/what-version/when/how, kept in the signatures table.
 */

/**
 * The kinds a `signatures` row can hold. Keep in step with the
 * signatures_kind_check constraint AND with everything that renders a
 * signature, because the failure mode there is silent rather than loud.
 *
 * /documents used to decide its label with `kind === 'storage' ? 'storage' :
 * 'contract'`, so when date_confirm arrived with Payments Policy v2 every date
 * confirmation was filed on the evidence register as a signed CONTRACT. Peter
 * reported them as duplicate contracts (2026-08-11) — three customers appeared
 * to have signed twice minutes apart, and one of the pairs had two different
 * spellings of the signer's name, which made it look like a double-submit bug
 * rather than two genuinely different documents.
 *
 * Consumers should key a `Record<SignatureKind, …>` off this type so a fourth
 * kind fails the BUILD instead of quietly inheriting the wrong label, and fall
 * back through signatureKindLabel() for a row whose kind is unknown at runtime.
 */
export type SignatureKind = "contract" | "storage" | "date_confirm";

const SIGNATURE_KIND_LABEL: Record<SignatureKind, string> = {
  contract: "Contract",
  storage: "Storage agreement",
  date_confirm: "Date confirmation",
};

export function isSignatureKind(kind: string): kind is SignatureKind {
  return Object.prototype.hasOwnProperty.call(SIGNATURE_KIND_LABEL, kind);
}

/** Never guesses: an unrecognised kind is "Signed document", not a wrong name. */
export function signatureKindLabel(kind: string): string {
  return isSignatureKind(kind) ? SIGNATURE_KIND_LABEL[kind] : "Signed document";
}

/** What the customer actually DID, for the register's one-line detail. Reads
 *  as "<action> online by Jane Smith" / "<action> in person by Jane Smith". */
export function signatureActionLabel(kind: string): string {
  if (kind === "date_confirm") return "Move date confirmed";
  if (kind === "storage") return "Storage agreement signed";
  return "Signed";
}

/** Bump when the published T&Cs change. GENERIC terms at launch — legal
 *  review before full go-live is tracked in ClickUp 869e35z42. */
export const TERMS_VERSION = "generic-v1-2026-07-10";

export const TERMS_URL = "https://marleymoves.co.uk/terms-conditions/";

/** Private storage bucket for signed contracts + completion-certificate PDFs.
 *  Access it ONLY through the media-store seam (createMediaStore(env, { bucket })),
 *  so it follows the active driver (Cloudflare R2 in prod, Supabase in dev).
 *  The DB stores the UN-prefixed object key (`completions/{appointmentId}.pdf`);
 *  the seam adds the bucket prefix internally — never store the prefix. */
export const JOB_DOCS_BUCKET = "job-docs";

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

/** The storage-agreement acknowledgments (kind='storage'). GENERIC wording at
 *  launch — legal review before full go-live (ClickUp 869e35z42); the lien
 *  clause is the one with real teeth. */
export const STORAGE_ACKS = [
  {
    key: "rate_advance",
    label: "I agree to the storage rate shown, billed in advance each period until I end the storage.",
  },
  {
    key: "lien",
    label:
      "I understand that if invoices stay unpaid for 60+ days, Marley Moves may, after written notice, dispose of or sell stored items to recover the charges.",
  },
  {
    key: "no_prohibited",
    label: "Nothing stored is hazardous, perishable, illegal, or irreplaceable without my own insurance.",
  },
] as const;

export type StorageAckKey = (typeof STORAGE_ACKS)[number]["key"];

/** Crate storage acknowledgments (standing policy 2026-07-22 —
 *  docs/storage-billing-v2-prd.md). Containers keep STORAGE_ACKS verbatim;
 *  crates replace the rate ack with the crate billing schedule. The minimum
 *  days and handling figure render LIVE from the Settings rate card so the
 *  signed wording always matches what's actually charged (PRD D1/D5) — a
 *  rate-card edit must be mirrored in the published terms clause. */
export function crateStorageAcks(minDays: number, handlingIncLabel: string) {
  const lien = STORAGE_ACKS.find((a) => a.key === "lien")!;
  const prohibited = STORAGE_ACKS.find((a) => a.key === "no_prohibited")!;
  return [
    {
      key: "crate_billing" as const,
      label: `I agree to the crate storage terms: ${minDays}-day minimum, then charged to the day; handling ${handlingIncLabel} inc VAT per crate in and out; all charges settled before release.`,
    },
    lien,
    prohibited,
  ];
}

export const CRATE_STORAGE_ACK_KEYS = ["crate_billing", "lien", "no_prohibited"] as const;
export type CrateStorageAckKey = (typeof CRATE_STORAGE_ACK_KEYS)[number];

export function allCrateStorageAcksConfirmed(acks: Record<string, unknown> | null | undefined): boolean {
  if (!acks) return false;
  return CRATE_STORAGE_ACK_KEYS.every((k) => acks[k] === true);
}

export function normalizeCrateStorageAcks(
  acks: Record<string, unknown> | null | undefined,
): Record<CrateStorageAckKey, boolean> {
  const out = {} as Record<CrateStorageAckKey, boolean>;
  for (const k of CRATE_STORAGE_ACK_KEYS) out[k] = acks?.[k] === true;
  return out;
}

/** The date-confirmation acknowledgment (kind='date_confirm', Payments Policy
 *  v2 — docs/payments-policy-v2-prd.md §5A). Single tick + signature on /q
 *  (or collected in person) that flips the deposit non-refundable and arms
 *  the commitment ladder. Wording is PROVISIONAL pending solicitor review —
 *  this string and the published T&Cs clause must ALWAYS change in the same
 *  commit. Deliberately "held/retained" framing; never "penalty". */
export const DATE_CONFIRM_ACKS = [
  {
    key: "date_confirm",
    label:
      "I'm confirming this move date. I understand my deposit is now non-refundable and still counts towards my final bill. If I later cancel or move this date within 7 days of the move and Marley Moves cannot re-book the day, amounts I've paid up to 25% of my job price may be retained, and are refunded in full if the day is re-booked.",
  },
] as const;

export type DateConfirmAckKey = (typeof DATE_CONFIRM_ACKS)[number]["key"];

export function allDateConfirmAcksConfirmed(
  acks: Record<string, unknown> | null | undefined,
): boolean {
  if (!acks) return false;
  return DATE_CONFIRM_ACKS.every((a) => acks[a.key] === true);
}

export function normalizeDateConfirmAcks(
  acks: Record<string, unknown> | null | undefined,
): Record<DateConfirmAckKey, boolean> {
  const out = {} as Record<DateConfirmAckKey, boolean>;
  for (const a of DATE_CONFIRM_ACKS) out[a.key] = acks?.[a.key] === true;
  return out;
}

export function allStorageAcksConfirmed(acks: Record<string, unknown> | null | undefined): boolean {
  if (!acks) return false;
  return STORAGE_ACKS.every((a) => acks[a.key] === true);
}

export function normalizeStorageAcks(
  acks: Record<string, unknown> | null | undefined,
): Record<StorageAckKey, boolean> {
  const out = {} as Record<StorageAckKey, boolean>;
  for (const a of STORAGE_ACKS) out[a.key] = acks?.[a.key] === true;
  return out;
}

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
