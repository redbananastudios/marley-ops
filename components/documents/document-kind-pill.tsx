import { isSignatureKind, signatureKindLabel, type SignatureKind } from "@/lib/signatures";

/**
 * The chip that names a document on the register.
 *
 * Shared by /documents and /clients/[id] on purpose: both used to decide the
 * label inline with `kind === 'storage' ? … : 'Contract'`, and both therefore
 * filed date confirmations as signed CONTRACTS when that kind was added
 * (2026-08-11). Two copies of a rule is how the second one goes stale, so
 * there is now one.
 *
 * Keying the maps off DocumentKind means a fourth signature kind fails the
 * BUILD rather than silently inheriting a label and a colour.
 */
export type DocumentKind = SignatureKind | "completion" | "other";

/** Signature rows carry a free-text kind; anything unrecognised reads as
 *  generic rather than borrowing the wrong document's name. */
export function toDocumentKind(kind: string): DocumentKind {
  return isSignatureKind(kind) ? kind : "other";
}

const CLS: Record<DocumentKind, string> = {
  contract: "border border-mm-red/45 bg-card text-mm-red-deep",
  date_confirm: "bg-info-bg text-info",
  storage: "bg-muted text-mist-500",
  completion: "bg-success-bg text-success",
  other: "bg-muted text-mist-500",
};

const LABEL: Record<DocumentKind, string> = {
  contract: signatureKindLabel("contract"),
  date_confirm: signatureKindLabel("date_confirm"),
  storage: signatureKindLabel("storage"),
  completion: "Completion certificate",
  other: signatureKindLabel("other"),
};

export const documentKindLabel = (kind: DocumentKind): string => LABEL[kind];

/**
 * The pill sits in a FIXED-WIDTH column (w-[180px], measured against the
 * longest label, "Completion certificate" at 170.8px in Geist 11/600 uppercase).
 * Letting each chip size itself left every row's customer name at a different
 * x, and that ragged edge reads as hierarchy — a short "Contract" chip made its
 * row look like a sub-item of the "Date confirmation" above it (Peter,
 * 2026-08-11). Below `sm` the column goes full width so the chip takes its own
 * line rather than squeezing the name on a phone.
 */
export function DocumentKindPill({ kind }: { kind: DocumentKind }) {
  return (
    <span className="w-full shrink-0 sm:w-[180px]">
      <span
        className={`inline-flex whitespace-nowrap rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${CLS[kind]}`}
      >
        {LABEL[kind]}
      </span>
    </span>
  );
}
