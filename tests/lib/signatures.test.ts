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

describe("the acks that name a company name the CUSTOMER'S company", () => {
  // A second brand's storage customer read a page whose header, logo, footer and
  // phone were all that brand's, and ticked a box granting the DEFAULT brand the
  // right to sell their belongings. Same shape on the date-confirmation tick,
  // which names the company that may retain up to 25% of what they have paid.
  //
  // Both now take the company as data. The two things that must hold are in
  // tension, so both are asserted rather than argued: an unbranded call renders
  // TODAY'S EXACT BYTES (PRD §1 — a single-brand install cannot move), and a
  // branded call actually substitutes (an inert switch is the failure mode that
  // looks identical to a correct one).

  /** The literals as they stood before the company became data. Written out in
   *  full on purpose: a test that rebuilds the string from the same template the
   *  code uses would pass on any wording change at all. */
  const LIEN_TODAY =
    "I understand that if invoices stay unpaid for 60+ days, Marley Moves may, after written notice, dispose of or sell stored items to recover the charges.";
  const DATE_CONFIRM_TODAY =
    "I'm confirming this move date. I understand my deposit is now non-refundable and still counts towards my final bill. If I later cancel or move this date within 7 days of the move and Marley Moves cannot re-book the day, amounts I've paid up to 25% of my job price may be retained, and are refunded in full if the day is re-booked.";

  it("byte parity: an unbranded call renders exactly what it rendered before", () => {
    expect(signaturesModule.STORAGE_ACKS.map((a) => a.key)).toEqual([
      "rate_advance",
      "lien",
      "no_prohibited",
    ]);
    expect(signaturesModule.STORAGE_ACKS[0].label).toBe(
      "I agree to the storage rate shown, billed in advance each period until I end the storage.",
    );
    expect(signaturesModule.STORAGE_ACKS[1].label).toBe(LIEN_TODAY);
    expect(signaturesModule.STORAGE_ACKS[2].label).toBe(
      "Nothing stored is hazardous, perishable, illegal, or irreplaceable without my own insurance.",
    );
    expect(signaturesModule.DATE_CONFIRM_ACKS).toHaveLength(1);
    expect(signaturesModule.DATE_CONFIRM_ACKS[0].label).toBe(DATE_CONFIRM_TODAY);

    // The builders reached with no argument, and with the shapes a blank
    // brands-table field actually takes, are the same thing.
    for (const blank of [undefined, null, "", "   "]) {
      expect(signaturesModule.storageAcks(blank)[1].label).toBe(LIEN_TODAY);
      expect(signaturesModule.dateConfirmAcks(blank)[0].label).toBe(DATE_CONFIRM_TODAY);
      expect(
        signaturesModule.crateStorageAcks({ kind: "calendar_month", days: 28 }, "£60", blank)[1].label,
      ).toBe(LIEN_TODAY);
    }
  });

  it("a branded call really substitutes — the switch is not inert", () => {
    // Unchanged output would be equally consistent with the company never being
    // read at all, so the discriminating assertion is that MUTATING the input
    // changes the output, and that the default brand's name is then absent.
    const lien = signaturesModule.storageAcks("Pitmans Removals")[1].label;
    expect(lien).toBe(
      "I understand that if invoices stay unpaid for 60+ days, Pitmans Removals may, after written notice, dispose of or sell stored items to recover the charges.",
    );
    expect(lien).not.toContain("Marley");

    const crateLien = signaturesModule.crateStorageAcks(
      { kind: "calendar_month", days: 28 },
      "£60",
      "Pitmans Removals",
    )[1].label;
    expect(crateLien).toBe(lien);

    const dateConfirm = signaturesModule.dateConfirmAcks("Pitmans Removals")[0].label;
    expect(dateConfirm).toContain("and Pitmans Removals cannot re-book the day");
    expect(dateConfirm).not.toContain("Marley");
    // Everything either side of the name is untouched — the substitution must
    // not be a rewrite of a clause a solicitor has read.
    expect(dateConfirm).toBe(DATE_CONFIRM_TODAY.replace("Marley Moves", "Pitmans Removals"));
  });

  it("the ack KEYS never move, whatever the brand — stored signatures are read back by key", () => {
    // acknowledgments/ack_labels are keyed; renaming or reordering a key
    // silently rewrites what every historical signature appears to have agreed
    // to. So the key list is fixed and the confirmed/normalise pairs run off it
    // rather than off a built label set.
    expect(signaturesModule.STORAGE_ACK_KEYS).toEqual(["rate_advance", "lien", "no_prohibited"]);
    expect(signaturesModule.DATE_CONFIRM_ACK_KEYS).toEqual(["date_confirm"]);
    expect(signaturesModule.storageAcks("Pitmans Removals").map((a) => a.key)).toEqual([
      ...signaturesModule.STORAGE_ACK_KEYS,
    ]);
    expect(
      signaturesModule.crateStorageAcks({ kind: "days", days: 28 }, "£60", "Pitmans Removals").map((a) => a.key),
    ).toEqual(["crate_billing", "lien", "no_prohibited"]);

    const ticked = { rate_advance: true, lien: true, no_prohibited: true };
    expect(signaturesModule.allStorageAcksConfirmed(ticked)).toBe(true);
    expect(signaturesModule.allStorageAcksConfirmed({ ...ticked, lien: false })).toBe(false);
    expect(Object.keys(signaturesModule.normalizeStorageAcks({ lien: true, evil: true } as never)).sort()).toEqual(
      ["lien", "no_prohibited", "rate_advance"],
    );
    expect(signaturesModule.allDateConfirmAcksConfirmed({ date_confirm: true })).toBe(true);
    expect(signaturesModule.allDateConfirmAcksConfirmed({ date_confirm: "1" } as never)).toBe(false);
    expect(Object.keys(signaturesModule.normalizeDateConfirmAcks({} as never))).toEqual(["date_confirm"]);
  });
});
