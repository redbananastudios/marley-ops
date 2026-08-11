/**
 * The published legal documents — the single answer to "which terms are live?"
 * and "what exactly did this customer agree to?".
 *
 * Replaces the hand-maintained `TERMS_VERSION` constant, which is the thing that
 * drifted: it read `generic-v1-2026-07-10` while the document it pointed at was
 * dated 16 June 2026, so every signature recorded agreement to a version
 * identifier that corresponded to nothing.
 *
 * Published versions are immutable. Changing terms means adding a file, never
 * editing one — `scripts/build-legal.mjs --check` runs in the gates and fails
 * the build if a published body no longer matches its recorded hash.
 */

import { LEGAL_VERSIONS, type LegalAcknowledgment, type LegalVersion } from "@/lib/legal/generated";

export type { LegalAcknowledgment, LegalVersion };

/** The documents customers sign. Keep in step with the folders under legal/. */
export type LegalDocument = "customer-terms" | "storage-terms";

const BY_ID = new Map(LEGAL_VERSIONS.map((v) => [v.id, v]));

/**
 * The version live right now for a document.
 *
 * Throws rather than returning null: every caller is on a signing path, and a
 * signature with no terms behind it is worse than a failed signature — the
 * customer would be committed to nothing we could later produce.
 */
export function currentVersion(document: LegalDocument): LegalVersion {
  const current = LEGAL_VERSIONS.find((v) => v.document === document && v.effective_to === null);
  if (!current) throw new Error(`No current version published for "${document}"`);
  return current;
}

/** A specific version by id. Null for an unknown id (e.g. a legacy string). */
export function versionById(id: string | null | undefined): LegalVersion | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Every version of a document, oldest first. */
export function versionsOf(document: LegalDocument): LegalVersion[] {
  return LEGAL_VERSIONS.filter((v) => v.document === document).sort((a, b) => a.version - b.version);
}

/**
 * Which version was live on a given day (yyyy-mm-dd), or null if none was.
 * This is how a historical signature gets mapped to the terms it was actually
 * served, and how the backfill establishes what the existing 13 agreed to.
 */
export function versionEffectiveOn(document: LegalDocument, day: string): LegalVersion | null {
  return (
    versionsOf(document).find(
      (v) => v.effective_from <= day && (v.effective_to === null || day < v.effective_to),
    ) ?? null
  );
}

/**
 * Everything a signature must record about the terms it was taken under.
 *
 * Every signing path calls this — there are five of them, and the reason this
 * returns one bundle rather than leaving each site to assemble its own is that
 * five copies of "remember to store the hash too" is exactly how one gets
 * missed. The acknowledgment LABELS travel with it because `acknowledgments`
 * on the signature row stores keys only: reword an ack and, without this, every
 * historical signature silently points at the new wording.
 */
export interface TermsSnapshot {
  terms_version: string;
  terms_sha256: string;
  terms_snapshot: string;
  acknowledgment_labels: Record<string, string>;
}

export function termsSnapshot(document: LegalDocument): TermsSnapshot {
  return snapshotOf(currentVersion(document));
}

/** The same bundle for a NAMED version — used by the historical backfill. */
export function snapshotOf(version: LegalVersion): TermsSnapshot {
  return {
    terms_version: version.id,
    terms_sha256: version.sha256,
    terms_snapshot: version.body,
    acknowledgment_labels: Object.fromEntries(version.acknowledgments.map((a) => [a.key, a.label])),
  };
}

/** Public URL of a document, for linking customers to what they are signing. */
export function publicUrlFor(document: LegalDocument): string {
  return document === "storage-terms"
    ? "https://marleymoves.co.uk/storage-terms/"
    : "https://marleymoves.co.uk/terms-conditions/";
}
