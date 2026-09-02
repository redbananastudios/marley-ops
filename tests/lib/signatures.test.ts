import { describe, expect, it } from "vitest";
import {
  allAcksConfirmed,
  CONTRACT_ACKS,
  isSignatureKind,
  isValidSignatureDataUri,
  normalizeAcks,
  signatureActionLabel,
  signatureKindLabel,
} from "@/lib/signatures";
import * as signaturesModule from "@/lib/signatures";
import { buildCompletionCertDocDef, type CompletionCertData } from "@/lib/completion-cert-docdef";

const ALL_TICKED = { inventory: true, owner_packed: true, no_hazardous: true };

describe("contract acknowledgments", () => {
  it("requires every box — one missing tick fails", () => {
    expect(allAcksConfirmed(ALL_TICKED)).toBe(true);
    expect(allAcksConfirmed({ ...ALL_TICKED, owner_packed: false })).toBe(false);
    expect(allAcksConfirmed({})).toBe(false);
    expect(allAcksConfirmed(null)).toBe(false);
    // truthy-but-not-true values don't count (a "1" from a tampered client)
    expect(allAcksConfirmed({ ...ALL_TICKED, inventory: "1" })).toBe(false);
  });

  it("normalizeAcks strips unknown keys and coerces to booleans", () => {
    const n = normalizeAcks({ inventory: true, evil_extra: true } as never);
    expect(Object.keys(n).sort()).toEqual(CONTRACT_ACKS.map((a) => a.key).sort());
    expect(n.inventory).toBe(true);
    expect(n.owner_packed).toBe(false);
  });

  it("no TERMS_VERSION constant survives here", () => {
    // It named a document that did not exist. Versions now come from
    // legal/ via lib/legal/documents (see tests/lib/legal/documents.test.ts).
    expect(Object.keys(signaturesModule)).not.toContain("TERMS_VERSION");
  });
});

describe("isValidSignatureDataUri", () => {
  const png = (chars: number) => `data:image/png;base64,${"A".repeat(chars)}`;

  it("accepts a plausible drawn-signature PNG", () => {
    expect(isValidSignatureDataUri(png(4000))).toBe(true);
  });
  it("rejects wrong mime, tiny payloads, oversize, and junk", () => {
    expect(isValidSignatureDataUri(`data:image/jpeg;base64,${"A".repeat(4000)}`)).toBe(false);
    expect(isValidSignatureDataUri(png(100))).toBe(false); // too small = empty canvas / nothing drawn
    expect(isValidSignatureDataUri(png(300_000))).toBe(false); // over the 200KB cap
    expect(isValidSignatureDataUri(`data:image/png;base64,${"<script>".repeat(200)}`)).toBe(false);
    expect(isValidSignatureDataUri(null)).toBe(false);
    expect(isValidSignatureDataUri(42)).toBe(false);
  });
});

describe("completion certificate doc-def", () => {
  const base: CompletionCertData = {
    quoteRef: "MM-260710-001",
    customerName: "Jane Doe",
    moveDate: "2026-07-15",
    from: "1 High Street, Gillingham, SP8 4GH",
    to: "2 Low Road, Poole, BH1 4DQ",
    crewName: "Jack Smith",
    crewSignature: "data:image/png;base64,CREWSIG",
    customerSignature: "data:image/png;base64,CUSTSIG",
    customerAbsent: false,
    absentReason: "",
    exceptions: "",
    signedAtLabel: "16:42 on Wednesday, 15 July 2026",
  };

  it("names a vfs font — an unset font (pdfmake's Roboto default) hangs createPdf", () => {
    expect(buildCompletionCertDocDef(base).defaultStyle.font).toBe("Montserrat");
  });

  it("carries both signatures + the nothing-to-report state", () => {
    const s = JSON.stringify(buildCompletionCertDocDef(base));
    for (const expected of [
      "CERTIFICATE OF COMPLETION",
      "Jane Doe",
      "Jack Smith",
      "CUSTSIG",
      "CREWSIG",
      "Nothing to report",
      "MM-260710-001",
      "Wednesday, 15 July 2026",
    ]) {
      expect(s).toContain(expected);
    }
  });

  it("exceptions replace the all-clear line", () => {
    const s = JSON.stringify(buildCompletionCertDocDef({ ...base, exceptions: "One lamp chipped" }));
    expect(s).toContain("One lamp chipped");
    expect(s).not.toContain("Nothing to report");
  });

  it("customer-absent renders the 48h check note and no customer signature image", () => {
    const s = JSON.stringify(
      buildCompletionCertDocDef({
        ...base,
        customerAbsent: true,
        customerSignature: null,
        absentReason: "delivery into storage",
      }),
    );
    expect(s).toContain("48 hours");
    expect(s).toContain("delivery into storage");
    expect(s).toContain("Not signed");
    expect(s).not.toContain("CUSTSIG");
  });

  it("NEVER leaks money — completion paperwork is price-free", () => {
    const s = JSON.stringify(buildCompletionCertDocDef({ ...base, exceptions: "scratch on table" }));
    expect(s).not.toContain("£");
    expect(s.toLowerCase()).not.toContain("deposit");
    expect(s.toLowerCase()).not.toContain("balance");
  });
});

describe("signature kind labels", () => {
  // Peter, 2026-08-11: three customers appeared on /documents to have signed
  // TWO contracts minutes apart. They had not. Each pair was one contract and
  // one date confirmation, and the register decided its label with
  // `kind === 'storage' ? 'storage' : 'contract'` — so every kind added after
  // that line was written inherited the word "Contract". On an evidence
  // register that is not a cosmetic bug: it is the wrong document produced to
  // an insurer or a dispute.
  it("names every kind for what it actually is", () => {
    expect(signatureKindLabel("contract")).toBe("Contract");
    expect(signatureKindLabel("storage")).toBe("Storage agreement");
    expect(signatureKindLabel("date_confirm")).toBe("Date confirmation");
  });

  it("never guesses at an unknown kind — the whole point of the bug", () => {
    // A fourth kind must read as a generic document, NOT inherit "Contract".
    for (const unknown of ["completion", "waiver", "", "CONTRACT"]) {
      expect(signatureKindLabel(unknown)).toBe("Signed document");
      expect(isSignatureKind(unknown)).toBe(false);
    }
    // ...and must not pick up anything off Object.prototype either.
    expect(isSignatureKind("toString")).toBe(false);
    expect(isSignatureKind("constructor")).toBe(false);
  });

  it("describes what the customer DID, so the detail line reads correctly", () => {
    expect(signatureActionLabel("contract")).toBe("Signed");
    expect(signatureActionLabel("date_confirm")).toBe("Move date confirmed");
    expect(signatureActionLabel("storage")).toBe("Storage agreement signed");
    // "Signed online by Jane" is a safe sentence for anything unrecognised.
    expect(signatureActionLabel("waiver")).toBe("Signed");
  });
});

describe("crate storage acks — the minimum wording follows the let's frozen min_kind", () => {
  // storage-terms v2 (2026-08-31) changed the crate minimum from "28 days"
  // to "one calendar month". The ack label a customer ticks is stored in
  // signatures.ack_labels beside the terms snapshot, so the two MUST agree:
  // a 'calendar_month' let never records a day-count minimum, and a legacy
  // 'days' let keeps the wording it signed under.
  it("crateMinimumLabel derives from the same rule the billing engine uses", () => {
    expect(signaturesModule.crateMinimumLabel("calendar_month", 28)).toBe("one calendar month minimum");
    expect(signaturesModule.crateMinimumLabel("days", 28)).toBe("28-day minimum");
    expect(signaturesModule.crateMinimumLabel(null, 28)).toBe("28-day minimum");
    expect(signaturesModule.crateMinimumLabel(undefined, 35)).toBe("35-day minimum");
  });

  it("a calendar-month let's ack says 'one calendar month minimum', never '28-day'", () => {
    const acks = signaturesModule.crateStorageAcks({ kind: "calendar_month", days: 28 }, "£60");
    const billing = acks.find((a) => a.key === "crate_billing")!;
    expect(billing.label).toContain("one calendar month minimum, then charged to the day");
    expect(billing.label).not.toContain("28-day");
  });

  it("a legacy days let keeps the exact wording it signed under (v1 terms)", () => {
    const acks = signaturesModule.crateStorageAcks({ kind: "days", days: 28 }, "£60");
    const billing = acks.find((a) => a.key === "crate_billing")!;
    expect(billing.label).toBe(
      "I agree to the crate storage terms: 28-day minimum, then charged to the day; handling £60 inc VAT per crate in and out; all charges settled before release.",
    );
  });

  it("lien and prohibited-items acks still ride along unchanged", () => {
    const acks = signaturesModule.crateStorageAcks({ kind: "calendar_month", days: 28 }, "£60");
    expect(acks.map((a) => a.key)).toEqual(["crate_billing", "lien", "no_prohibited"]);
  });
});
