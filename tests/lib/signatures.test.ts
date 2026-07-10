import { describe, expect, it } from "vitest";
import {
  allAcksConfirmed,
  CONTRACT_ACKS,
  isValidSignatureDataUri,
  normalizeAcks,
  TERMS_VERSION,
} from "@/lib/signatures";
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

  it("terms version names the generic launch terms", () => {
    expect(TERMS_VERSION).toContain("generic");
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
