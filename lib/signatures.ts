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

/**
 * `TERMS_VERSION` was here. It is gone deliberately.
 *
 * It was a hand-maintained string (`generic-v1-2026-07-10`) stamped onto every
 * signature, and it named a document that did not exist: the terms it pointed
 * at were dated 16 June 2026 and lived as hardcoded JSX on the website, edited
 * in place. So the system could name a version it could not produce.
 *
 * The published documents now live in `legal/` and are the source of both the
 * version id and the text. Use:
 *   termsSnapshot("customer-terms") — the bundle every signature must store
 *   currentVersion(doc) / publicUrlFor(doc) — from @/lib/legal/documents
 *
 * Do not reintroduce a constant here. A version identifier that is maintained
 * separately from the document it names will drift again.
 */

/**
 * The DEFAULT brand's published terms. A default-brand constant, not a
 * universal one: `PageTheme.termsUrl` (lib/brand-page-theme.ts) resolves the
 * brand's own `terms_url` and falls back to this, so any brand-resolved surface
 * must read it from the theme rather than importing this. The one importer left
 * is the in-person crew contract flow (components/crew/collect-contract-button
 * .tsx), which takes no brand at all yet, so every brand's customer signs
 * against the default brand's terms there. Named in the brand-leak scan's
 * STILL-NOT-manifest note; gate 15 is what retires the whole question.
 */
export const TERMS_URL = "https://marleymoves.co.uk/terms-conditions/";

/**
 * The company a tick-box names as the party the customer is granting something
 * to — disposal rights over stored goods, the right to retain money on a
 * cancelled date. The DEFAULT brand's trading name, and the fallback for every
 * ack builder below.
 *
 * ## Why the acks are built, not written
 *
 * Two of these tick-boxes named a company in their text, and both were
 * hardcoded. A second brand's storage customer read a page whose header, logo,
 * footer and phone were all that brand's, and ticked a box granting the DEFAULT
 * brand the right to sell their belongings. It is the clause in this file with
 * the most teeth, and it named the wrong company.
 *
 * Every brand is a trading name of ONE operating company (PRD §2:
 * `PageTheme.legalEntity`), so nothing here was legally void — but a signed
 * agreement that names a trading name the customer has never dealt with is
 * wrong copy on the one document that exists to be produced years later.
 *
 * So the company arrives as data. Callers on a brand-resolved surface pass
 * `pageTheme(...).name`; callers with no brand in hand omit it and get today's
 * exact bytes, which is the §1 single-brand invariant and is pinned by a test
 * (tests/lib/signatures.test.ts, "byte parity").
 *
 * ## What this does NOT reach
 *
 * The PUBLISHED terms are separate and immutable. `termsSnapshot()` stores the
 * document body and the document's OWN acknowledgment labels (legal/, hashed,
 * `scripts/build-legal.mjs --check` in the gates), and those still name the
 * default brand for every brand. That is gate 15's job — a published version
 * cannot be edited, only superseded — so the two are deliberately different
 * columns on `signatures`: `ack_labels` is what was RENDERED, and
 * `acknowledgment_labels` is what the published document said.
 */
export const DEFAULT_SIGNING_COMPANY = "Marley Moves";

/** Blank, whitespace or absent → the default brand's name, never an empty gap
 *  in the middle of a sentence a customer is about to sign. */
function signingCompany(companyName?: string | null): string {
  return (companyName ?? "").trim() || DEFAULT_SIGNING_COMPANY;
}

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

/**
 * The storage-agreement ack KEYS — the identity of each tick-box, and the thing
 * stored in `signatures.acknowledgments`.
 *
 * Split from the labels deliberately (same shape as CRATE_STORAGE_ACK_KEYS
 * below). The labels now vary by brand; the keys must not, because a stored
 * signature is read back by key years later. Never renumber, rename or reorder
 * these — a key that changes meaning silently rewrites what every historical
 * signature appears to have agreed to.
 */
export const STORAGE_ACK_KEYS = ["rate_advance", "lien", "no_prohibited"] as const;

export type StorageAckKey = (typeof STORAGE_ACK_KEYS)[number];

/** The storage-agreement acknowledgments (kind='storage'). GENERIC wording at
 *  launch — legal review before full go-live (ClickUp 869e35z42); the lien
 *  clause is the one with real teeth, and it is the one that names a company —
 *  see `DEFAULT_SIGNING_COMPANY` for why that arrives as data. */
export function storageAcks(
  companyName?: string | null,
): ReadonlyArray<{ key: StorageAckKey; label: string }> {
  const company = signingCompany(companyName);
  return [
    {
      key: "rate_advance",
      label: "I agree to the storage rate shown, billed in advance each period until I end the storage.",
    },
    {
      key: "lien",
      label: `I understand that if invoices stay unpaid for 60+ days, ${company} may, after written notice, dispose of or sell stored items to recover the charges.`,
    },
    {
      key: "no_prohibited",
      label: "Nothing stored is hazardous, perishable, illegal, or irreplaceable without my own insurance.",
    },
  ];
}

/** The DEFAULT brand's storage acks — today's exact bytes, for every caller
 *  that has no brand in hand. A brand-resolved surface calls `storageAcks(name)`
 *  instead. */
export const STORAGE_ACKS = storageAcks();

/** The minimum-stay wording, derived from the let's frozen min_kind — the
 *  SAME dial lib/storage-billing.ts bills from, so the ack a customer ticks,
 *  the terms snapshot stored beside it, and the engine's window always agree.
 *  'calendar_month' = storage-terms v2 (2026-08-31): one calendar month from
 *  the start date. Anything else = the v1 fixed day count (min_days). */
export function crateMinimumLabel(minKind: string | null | undefined, minDays: number): string {
  return minKind === "calendar_month" ? "one calendar month minimum" : `${minDays}-day minimum`;
}

/** Crate storage acknowledgments (standing policy 2026-07-22 —
 *  docs/storage-billing-v2-prd.md; minimum re-worded by storage-terms v2,
 *  2026-08-31). Containers keep STORAGE_ACKS verbatim; crates replace the
 *  rate ack with the crate billing schedule. The minimum wording follows the
 *  let's frozen min_kind/min_days (crateMinimumLabel) and the handling figure
 *  renders LIVE from the Settings rate card so the signed wording always
 *  matches what's actually charged (PRD D1/D5) — a rate-card edit must be
 *  mirrored in the published terms clause. `companyName` threads through to the
 *  lien clause the crate set carries verbatim; omit it for today's bytes. */
export function crateStorageAcks(
  minimum: { kind: string | null | undefined; days: number },
  handlingIncLabel: string,
  companyName?: string | null,
) {
  const base = storageAcks(companyName);
  const lien = base.find((a) => a.key === "lien")!;
  const prohibited = base.find((a) => a.key === "no_prohibited")!;
  return [
    {
      key: "crate_billing" as const,
      label: `I agree to the crate storage terms: ${crateMinimumLabel(minimum.kind, minimum.days)}, then charged to the day; handling ${handlingIncLabel} inc VAT per crate in and out; all charges settled before release.`,
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
export const DATE_CONFIRM_ACK_KEYS = ["date_confirm"] as const;

export type DateConfirmAckKey = (typeof DATE_CONFIRM_ACK_KEYS)[number];

export function dateConfirmAcks(
  companyName?: string | null,
): ReadonlyArray<{ key: DateConfirmAckKey; label: string }> {
  const company = signingCompany(companyName);
  return [
    {
      key: "date_confirm",
      label: `I'm confirming this move date. I understand my deposit is now non-refundable and still counts towards my final bill. If I later cancel or move this date within 7 days of the move and ${company} cannot re-book the day, amounts I've paid up to 25% of my job price may be retained, and are refunded in full if the day is re-booked.`,
    },
  ];
}

/** The DEFAULT brand's date-confirmation ack — today's exact bytes. A
 *  brand-resolved surface calls `dateConfirmAcks(name)` instead. */
export const DATE_CONFIRM_ACKS = dateConfirmAcks();

// The confirmed/normalise pairs below run off the KEY lists, never off a built
// label set: which boxes were ticked is a fact about the record and must not
// move when the wording that names a brand does.

export function allDateConfirmAcksConfirmed(
  acks: Record<string, unknown> | null | undefined,
): boolean {
  if (!acks) return false;
  return DATE_CONFIRM_ACK_KEYS.every((k) => acks[k] === true);
}

export function normalizeDateConfirmAcks(
  acks: Record<string, unknown> | null | undefined,
): Record<DateConfirmAckKey, boolean> {
  const out = {} as Record<DateConfirmAckKey, boolean>;
  for (const k of DATE_CONFIRM_ACK_KEYS) out[k] = acks?.[k] === true;
  return out;
}

export function allStorageAcksConfirmed(acks: Record<string, unknown> | null | undefined): boolean {
  if (!acks) return false;
  return STORAGE_ACK_KEYS.every((k) => acks[k] === true);
}

export function normalizeStorageAcks(
  acks: Record<string, unknown> | null | undefined,
): Record<StorageAckKey, boolean> {
  const out = {} as Record<StorageAckKey, boolean>;
  for (const k of STORAGE_ACK_KEYS) out[k] = acks?.[k] === true;
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
