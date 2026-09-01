import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LEGAL_VERSIONS } from "@/lib/legal/generated";
import {
  currentVersion,
  publicUrlFor,
  snapshotOf,
  STORAGE_PAYMENT_SENTENCE,
  termsSnapshot,
  versionById,
  versionEffectiveOn,
  versionsOf,
} from "@/lib/legal/documents";

/**
 * These guard the property the whole system rests on: that we can say, for any
 * signature, exactly what the customer was served — and prove the text has not
 * changed since. `terms_version` used to be a hand-maintained string reading
 * `generic-v1-2026-07-10` while the document it named was dated 16 June 2026.
 */

describe("published legal documents", () => {
  it("every recorded hash actually matches its body", () => {
    // The tamper check. If a published file is edited in place, this fails.
    for (const v of LEGAL_VERSIONS) {
      expect(createHash("sha256").update(v.body, "utf8").digest("hex"), `${v.id} body hash`).toBe(v.sha256);
    }
  });

  it("has exactly one current version per document, and it is the newest", () => {
    for (const doc of ["customer-terms", "storage-terms"] as const) {
      const versions = versionsOf(doc);
      expect(versions.length, `${doc} has versions`).toBeGreaterThan(0);
      const current = versions.filter((v) => v.effective_to === null);
      expect(current, `${doc} current`).toHaveLength(1);
      expect(current[0].version).toBe(Math.max(...versions.map((v) => v.version)));
      expect(currentVersion(doc).id).toBe(current[0].id);
    }
  });

  it("covers the timeline with no gap and no overlap", () => {
    // A gap is a day where we cannot answer "which terms were live?" — the
    // exact question a dispute asks.
    for (const doc of ["customer-terms", "storage-terms"] as const) {
      const versions = versionsOf(doc);
      versions.forEach((v, i) => {
        if (i === 0) return;
        expect(versions[i - 1].effective_to, `${v.id} follows without a gap`).toBe(v.effective_from);
      });
    }
  });

  it("carries the acknowledgment WORDING, not just the keys", () => {
    // signatures.acknowledgments stores {inventory: true} — keys only. Without
    // the labels travelling with the version, rewording an ack silently
    // rewrites what every historical signature appears to have agreed to.
    const snap = termsSnapshot("customer-terms");
    expect(Object.keys(snap.acknowledgment_labels).sort()).toEqual(
      ["inventory", "no_hazardous", "owner_packed"].sort(),
    );
    expect(snap.acknowledgment_labels.owner_packed).toContain("pack myself");
  });

  it("termsSnapshot returns a self-sufficient evidence bundle", () => {
    const snap = termsSnapshot("customer-terms");
    expect(snap.terms_version).toBe(currentVersion("customer-terms").id);
    expect(snap.terms_sha256).toHaveLength(64);
    expect(createHash("sha256").update(snap.terms_snapshot, "utf8").digest("hex")).toBe(snap.terms_sha256);
    expect(snap.terms_snapshot.length).toBeGreaterThan(500);
  });
});

describe("versionEffectiveOn — mapping a historical signature to its terms", () => {
  it("resolves the 13 existing signatures to customer-terms v1", () => {
    // Every signature on prod was taken between 31 Jul and 10 Aug 2026, while
    // the 16 June text was live and unchanged (site commit 8d01497).
    for (const day of ["2026-07-31", "2026-08-03", "2026-08-05", "2026-08-06", "2026-08-10"]) {
      expect(versionEffectiveOn("customer-terms", day)?.version, day).toBe(1);
    }
  });

  it("switches versions on each effective date, not before", () => {
    expect(versionEffectiveOn("customer-terms", "2026-08-10")?.version).toBe(1);
    expect(versionEffectiveOn("customer-terms", "2026-08-11")?.version).toBe(2);
    expect(versionEffectiveOn("customer-terms", "2026-08-30")?.version).toBe(2);
    expect(versionEffectiveOn("customer-terms", "2026-08-31")?.version).toBe(3);
    expect(versionEffectiveOn("customer-terms", "2027-01-01")?.version).toBe(3);

    expect(versionEffectiveOn("storage-terms", "2026-08-30")?.version).toBe(1);
    expect(versionEffectiveOn("storage-terms", "2026-08-31")?.version).toBe(2);
  });

  it("returns null before anything was published", () => {
    expect(versionEffectiveOn("customer-terms", "2026-01-01")).toBeNull();
    expect(versionEffectiveOn("storage-terms", "2026-08-10")).toBeNull();
  });
});

describe("versionById", () => {
  it("finds a published version and refuses an unknown one", () => {
    expect(versionById("customer-terms-v1-2026-06-16")?.version).toBe(1);
    // The legacy constant. It must NOT resolve — pretending it maps to a real
    // document is how the original bug read as working.
    expect(versionById("generic-v1-2026-07-10")).toBeNull();
    expect(versionById(null)).toBeNull();
  });
});

describe("the corrected terms actually say what the system enforces", () => {
  // The reason the current terms exist. If someone edits these clauses back out, this fails.
  const terms = currentVersion("customer-terms").body.toLowerCase();

  it("states the 25% commitment and the 7-day window", () => {
    expect(terms).toContain("25%");
    expect(terms).toContain("7 days before your move");
  });

  it("ties retention to the day being re-booked, and never says penalty", () => {
    expect(terms).toContain("re-book");
    // Hard copy rule from the payments policy: held money is never a penalty.
    expect(terms).not.toContain("penalty");
  });

  it("no longer promises a full refund up to 48 hours before the move", () => {
    // The v1 clause that contradicted the app.
    expect(terms).not.toContain("48 hours");
    expect(currentVersion("customer-terms").body).not.toContain("fully refundable if you cancel");
  });

  it("keeps the deposit refundable UNTIL the date is confirmed", () => {
    expect(terms).toContain("until you confirm your move date, your deposit is fully refundable");
  });

  it("accepts every payment method while preferring bank transfer", () => {
    expect(terms).toContain("bank transfer, card or cash for all payments");
    expect(terms).toContain("bank transfer is preferred");
    expect(terms).not.toContain("card payments are for deposits only");
  });

  it("carries no em-dash, per the house copy rule", () => {
    for (const v of LEGAL_VERSIONS.filter((x) => x.version > 1)) {
      expect(v.body, `${v.id} em-dash`).not.toMatch(/—/);
    }
  });
});

describe("storage terms", () => {
  const storage = currentVersion("storage-terms").body.toLowerCase();

  it("finally puts a document behind the lien acknowledgment", () => {
    // Customers were ticking "may dispose of or sell stored items" with nothing
    // published behind it. The procedure now has to be stated.
    expect(storage).toContain("60 days");
    expect(storage).toContain("written notice");
    expect(storage).toContain("3 further months");
    expect(storage).toContain("surplus is returned");
  });

  it("does not claim stored goods are insured by us", () => {
    // Cover for goods in storage is unconfirmed with the insurer, so the terms
    // must not imply it.
    expect(storage).toContain("arrange your own insurance");
    expect(storage).toContain("not while they are in storage");
  });

  it("accepts every payment method and requires settlement before release", () => {
    expect(storage).toContain("bank transfer, card or cash");
    expect(storage).toContain("bank transfer is preferred");
    expect(storage).toContain("settled before your belongings are released");
  });

  it("bills crates for one calendar month minimum, then to the exact release date", () => {
    expect(storage).toContain("minimum period of one calendar month");
    expect(storage).toContain("final invoice runs only to the date your belongings leave storage");
    expect(storage).toContain("for containers only");
    expect(storage).not.toContain("minimum period of 28 days");
    expect(storage).not.toContain("from day 29");
  });
});

describe("STORAGE_PAYMENT_SENTENCE", () => {
  it("is verbatim from the CURRENT storage terms (QA-20260901-01)", () => {
    // The /s/[token] signing page shows this sentence beside its link to the
    // storage terms. It once hand-maintained its own copy, which said
    // "payable by bank transfer on receipt" while the v2 terms it linked to
    // accepted card and cash. Pinning the constant to the current body means
    // a v3 with different payment wording fails here until the page copy
    // moves with it.
    expect(currentVersion("storage-terms").body).toContain(STORAGE_PAYMENT_SENTENCE);
  });

  it("does not revert to bank-transfer-only", () => {
    expect(STORAGE_PAYMENT_SENTENCE.toLowerCase()).toContain("card");
    expect(STORAGE_PAYMENT_SENTENCE.toLowerCase()).toContain("cash");
    expect(STORAGE_PAYMENT_SENTENCE).not.toContain("payable by bank transfer on receipt");
  });
});

describe("publicUrlFor", () => {
  it("points each document at its own page", () => {
    expect(publicUrlFor("customer-terms")).toContain("/terms-conditions/");
    expect(publicUrlFor("storage-terms")).toContain("/storage-terms/");
  });
});

describe("snapshotOf", () => {
  it("can rebuild the bundle for a superseded version (the backfill path)", () => {
    const v1 = versionById("customer-terms-v1-2026-06-16")!;
    const snap = snapshotOf(v1);
    expect(snap.terms_version).toBe(v1.id);
    expect(snap.terms_snapshot).toContain("fully refundable if you cancel more than 48 hours");
    expect(createHash("sha256").update(snap.terms_snapshot, "utf8").digest("hex")).toBe(snap.terms_sha256);
  });
});
