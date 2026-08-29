import { describe, expect, it } from "vitest";

import {
  brandIngestSecrets,
  firstIssueMessage,
  ingestAuthorized,
  MAX_SUBMISSION_AGE_MS,
  payloadBrandMismatch,
  resolveIngestBrand,
  sharedIngestSecretBrands,
  resolveSubmittedAt,
  websiteLeadIngestSchema,
} from "@/lib/leads/ingest";
import { isFreshEnquiryTimestamp } from "@/lib/push/categories";

/**
 * The direct lead ingest is the only unauthenticated-by-session surface that
 * WRITES a customer record, and the website's fallback (email the office, text
 * Peter) fires on whatever this endpoint answers. So these tests pin the three
 * things that decide whether a real enquiry reaches a human: who may post, what
 * counts as a usable lead, and what a timestamp is allowed to claim.
 */

const SECRET = "s3cret-value-long-enough";

describe("ingestAuthorized", () => {
  it("accepts the configured secret presented as a bearer token", () => {
    expect(ingestAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["null", null],
    ["blank", ""],
    ["whitespace", "   "],
    ["a placeholder too short to be a credential", "changeme"],
  ])("fails CLOSED when the secret is %s — every request is refused", (_label, secret) => {
    // The failure this prevents: one missing environment variable turning the
    // route into an open lead-injection endpoint, with nothing saying so.
    expect(ingestAuthorized(`Bearer ${SECRET}`, secret)).toBe(false);
    expect(ingestAuthorized("Bearer anything", secret)).toBe(false);
    expect(ingestAuthorized(null, secret)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["the bare secret with no scheme", SECRET],
    ["the wrong scheme", `Basic ${SECRET}`],
    ["a wrong secret of the same length", "S3CRET-VALUE-LONG-ENOUGH"],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 10)}`],
    ["the secret plus trailing junk", `Bearer ${SECRET}x`],
  ])("refuses a header that is %s", (_label, header) => {
    expect(ingestAuthorized(header, SECRET)).toBe(false);
  });

  it("tolerates surrounding whitespace on the header but not inside the token", () => {
    expect(ingestAuthorized(`  Bearer ${SECRET}  `, SECRET)).toBe(true);
    expect(ingestAuthorized(`Bearer ${SECRET.slice(0, 5)} ${SECRET.slice(5)}`, SECRET)).toBe(false);
  });
});

describe("brand resolution — WHICH secret matched IS the brand (PRD §3.8)", () => {
  const MARLEY = SECRET;
  const PITMANS = "p1tmans-secret-long-enough";
  const secrets = brandIngestSecrets({
    LEAD_INGEST_SECRET: MARLEY,
    LEAD_INGEST_SECRET_PITMANS: PITMANS,
  });

  it("collects Marley's original variable plus one per LEAD_INGEST_SECRET_<SLUG>", () => {
    expect(secrets).toEqual([
      { brand: "marley", secret: MARLEY },
      { brand: "pitmans", secret: PITMANS },
    ]);
  });

  it("resolves each brand from its own secret", () => {
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, secrets)).toBe("marley");
    expect(resolveIngestBrand(`Bearer ${PITMANS}`, secrets)).toBe("pitmans");
  });

  it("resolves nothing for a wrong or absent secret", () => {
    expect(resolveIngestBrand("Bearer wrong-but-plenty-long-enough", secrets)).toBe(null);
    expect(resolveIngestBrand(null, secrets)).toBe(null);
  });

  it("an unconfigured per-brand secret never matches — Marley alone behaves exactly as before", () => {
    const marleyOnly = brandIngestSecrets({ LEAD_INGEST_SECRET: MARLEY });
    expect(marleyOnly).toEqual([{ brand: "marley", secret: MARLEY }]);
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, marleyOnly)).toBe("marley");
    expect(resolveIngestBrand(`Bearer ${PITMANS}`, marleyOnly)).toBe(null);
  });

  it("a placeholder-short or blank per-brand secret fails CLOSED, like Marley's always has", () => {
    const s = brandIngestSecrets({ LEAD_INGEST_SECRET_PITMANS: "changeme", LEAD_INGEST_SECRET_GROUP: "" });
    expect(resolveIngestBrand("Bearer changeme", s)).toBe(null);
    expect(resolveIngestBrand("Bearer ", s)).toBe(null);
  });
});

describe("payloadBrandMismatch", () => {
  it("passes a body that names no brand — Marley's live site sends none", () => {
    expect(payloadBrandMismatch({ leadId: "x" }, "marley")).toBe(false);
    expect(payloadBrandMismatch({ leadId: "x", brand: null }, "marley")).toBe(false);
    expect(payloadBrandMismatch(null, "marley")).toBe(false);
    expect(payloadBrandMismatch([{ brand: "pitmans" }], "marley")).toBe(false);
  });

  it("passes a claim that agrees with the secret's brand", () => {
    expect(payloadBrandMismatch({ brand: "pitmans" }, "pitmans")).toBe(false);
  });

  it("refuses a claim the secret cannot vouch for — exactly, case and type included", () => {
    expect(payloadBrandMismatch({ brand: "marley" }, "pitmans")).toBe(true);
    expect(payloadBrandMismatch({ brand: "Pitmans" }, "pitmans")).toBe(true);
    expect(payloadBrandMismatch({ brand: 1234 }, "pitmans")).toBe(true);
  });
});

describe("websiteLeadIngestSchema", () => {
  const valid = {
    leadId: "4f1c2a90-1d3e-4a55-9d2b-7c0a11223344",
    name: "paul betty",
    phone: "07572 382366",
  };

  it("accepts the minimum a usable lead needs", () => {
    const parsed = websiteLeadIngestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("carries every attribution field through under the site's own names", () => {
    const parsed = websiteLeadIngestSchema.parse({
      ...valid,
      attribution: {
        gclid: "G1",
        gbraid: "GB1",
        wbraid: "WB1",
        fbclid: "FB1",
        msclkid: "MS1",
        ttclid: "TT1",
        liFatId: "LI1",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "removals",
        utmContent: "hero",
        utmTerm: "man and van",
        utmId: "17",
        campaign: "free-boxes-2026-06",
        variantKey: "lead-form-hero-red",
        landingUrl: "/removals/shaftesbury?gclid=G1",
        landingReferrer: "https://www.google.com/",
        posthogDistinctId: "ph-1",
      },
    });
    expect(parsed.attribution).toMatchObject({
      gclid: "G1",
      ttclid: "TT1",
      liFatId: "LI1",
      utmId: "17",
      landingReferrer: "https://www.google.com/",
      posthogDistinctId: "ph-1",
    });
  });

  it("strips unknown keys instead of refusing them", () => {
    // The site will grow new click ids. Losing a lead over a field we have not
    // heard of yet would be a self-inflicted outage.
    const parsed = websiteLeadIngestSchema.parse({
      ...valid,
      somethingNew: "x",
      attribution: { gclid: "G1", brandNewClickId: "z" },
    });
    expect(parsed).not.toHaveProperty("somethingNew");
    expect(parsed.attribution).not.toHaveProperty("brandNewClickId");
  });

  it("requires a way to contact the customer", () => {
    const parsed = websiteLeadIngestSchema.safeParse({ leadId: valid.leadId, name: "Paul Betty" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe("provide a phone or an email");
  });

  it("accepts an email-only enquiry", () => {
    expect(
      websiteLeadIngestSchema.safeParse({ leadId: valid.leadId, name: "Paul Betty", email: "p@example.com" }).success,
    ).toBe(true);
  });

  it("does NOT reject a mistyped email — a typo is not a malformed request", () => {
    // Losing a lead that has a good phone number because the customer fumbled
    // their address would be the worse failure; the bounce handler is the guard.
    const parsed = websiteLeadIngestSchema.parse({ ...valid, email: "paul@gmail" });
    expect(parsed.email).toBe("paul@gmail");
  });

  it.each([
    ["a missing leadId", { name: "Paul", phone: "07000 000000" }],
    ["a leadId too short to be unique", { ...valid, leadId: "abc" }],
    ["a leadId carrying filter-breaking punctuation", { ...valid, leadId: "a,b'c(d)" }],
    ["a missing name", { leadId: valid.leadId, phone: "07000 000000" }],
    ["a blank name", { ...valid, name: "   " }],
    ["a name over the column's length", { ...valid, name: "x".repeat(201) }],
    ["notes over the length cap", { ...valid, notes: "x".repeat(5001) }],
    ["services that are not an array", { ...valid, services: "packing" }],
    ["a batch of enquiries", [valid, valid]],
  ])("refuses %s", (_label, payload) => {
    expect(websiteLeadIngestSchema.safeParse(payload).success).toBe(false);
  });

  it("collapses empty strings to null so a blank field never reaches a column", () => {
    const parsed = websiteLeadIngestSchema.parse({ ...valid, email: "", toPostcode: "  ", notes: "" });
    expect(parsed.email).toBeNull();
    expect(parsed.toPostcode).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it("defaults services to an empty array — the column is not nullable", () => {
    expect(websiteLeadIngestSchema.parse(valid).services).toEqual([]);
  });
});

describe("resolveSubmittedAt", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("stamps arrival time when the caller sends none", () => {
    expect(resolveSubmittedAt(null, now)).toEqual({ ok: true, submittedAt: now.toISOString() });
  });

  it("keeps a timestamp from a few minutes ago", () => {
    const when = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(resolveSubmittedAt(when, now)).toEqual({ ok: true, submittedAt: when });
  });

  it("refuses a backdated submission — this route can never import history", () => {
    // Requirement behind the LEAD_SYNC_SINCE floor, enforced structurally on the
    // push side: no payload can make a months-old enquiry appear as a new lead.
    const old = new Date(now.getTime() - 400 * 86_400_000).toISOString();
    const verdict = resolveSubmittedAt(old, now);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("live enquiries only");
  });

  it("refuses a timestamp it cannot parse rather than guessing", () => {
    expect(resolveSubmittedAt("last tuesday", now).ok).toBe(false);
  });

  it("clamps a caller whose clock runs fast instead of losing the lead", () => {
    // A future timestamp cannot smuggle history in, so refusing it would cost a
    // real enquiry over a few seconds of clock skew.
    const ahead = new Date(now.getTime() + 90_000).toISOString();
    expect(resolveSubmittedAt(ahead, now)).toEqual({ ok: true, submittedAt: now.toISOString() });
  });

  it("guarantees anything it accepts still counts as FRESH for the office alarm", () => {
    // The property that matters operationally: an accepted lead always raises
    // the push and the in-app chime, because the accept window and the
    // freshness window are the same constant.
    const oldest = new Date(now.getTime() - MAX_SUBMISSION_AGE_MS).toISOString();
    const verdict = resolveSubmittedAt(oldest, now);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(isFreshEnquiryTimestamp(verdict.submittedAt, now)).toBe(true);

    const justPast = new Date(now.getTime() - MAX_SUBMISSION_AGE_MS - 1000).toISOString();
    expect(resolveSubmittedAt(justPast, now).ok).toBe(false);
  });
});

/**
 * A duplicate secret is a question with no answer (QA-20260826-09). Resolving
 * it to the first match hides the ambiguity rather than settling it, and the
 * first candidate is always the default brand - so the quiet outcome is the
 * OTHER brand's customer filed under the default one, with its quote-ref
 * prefix, its legal line and its sending address on a document a real person
 * receives.
 */
describe("brandIngestSecrets — an ambiguous credential authenticates nobody", () => {
  const MARLEY = "marley-secret-long-enough";
  const OTHER = "other-secret-long-enough";

  it("two brands sharing one secret authenticate NEITHER - not the first match", () => {
    const shared = brandIngestSecrets({
      LEAD_INGEST_SECRET: MARLEY,
      LEAD_INGEST_SECRET_PITMANS: MARLEY,
    });
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, shared)).toBe(null);
  });

  it("a duplicate does not disarm a third brand whose secret is its own", () => {
    const mixed = brandIngestSecrets({
      LEAD_INGEST_SECRET: MARLEY,
      LEAD_INGEST_SECRET_PITMANS: MARLEY,
      LEAD_INGEST_SECRET_THIRD: OTHER,
    });
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, mixed)).toBe(null);
    expect(resolveIngestBrand(`Bearer ${OTHER}`, mixed)).toBe("third");
  });

  it("a unique secret is completely unaffected", () => {
    const clean = brandIngestSecrets({
      LEAD_INGEST_SECRET: MARLEY,
      LEAD_INGEST_SECRET_PITMANS: OTHER,
    });
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, clean)).toBe("marley");
    expect(resolveIngestBrand(`Bearer ${OTHER}`, clean)).toBe("pitmans");
  });

  it("two blank or placeholder-short values are not a collision", () => {
    // They authenticate nothing already; counting them would disable a brand
    // that was never configured in the first place.
    const blanks = brandIngestSecrets({
      LEAD_INGEST_SECRET: "",
      LEAD_INGEST_SECRET_PITMANS: "",
    });
    expect(resolveIngestBrand("Bearer ", blanks)).toBe(null);
    expect(blanks.length).toBe(2);
  });

  it("the same brand twice is not an ambiguity — the default brand's own alias must not disable it", () => {
    // `configuredIngestSecrets` seeds marley from LEAD_INGEST_SECRET and THEN
    // scans the LEAD_INGEST_SECRET_ prefix, so the documented per-brand form of
    // the default brand's own name produces a second `marley` entry carrying the
    // one real credential. Counted by VALUE that read as a collision, so both
    // were nulled and every genuine enquiry from the live marleymoves.co.uk site
    // 401'd. There is nothing to disambiguate: whichever entry matched, the
    // answer is `marley`.
    const env = { LEAD_INGEST_SECRET: MARLEY, LEAD_INGEST_SECRET_MARLEY: MARLEY };
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, brandIngestSecrets(env))).toBe("marley");
    expect(sharedIngestSecretBrands(env)).toEqual([]);
  });

  it("but a THIRD variable pulling a second brand onto that value still refuses everyone", () => {
    // The alias is only safe while one brand claims the value. The moment
    // another brand does, the credential is ambiguous again and yields nothing.
    const env = {
      LEAD_INGEST_SECRET: MARLEY,
      LEAD_INGEST_SECRET_MARLEY: MARLEY,
      LEAD_INGEST_SECRET_PITMANS: MARLEY,
    };
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, brandIngestSecrets(env))).toBe(null);
    // Each refused brand named once — repeating `marley` for its two variables
    // tells an operator nothing extra.
    expect(sharedIngestSecretBrands(env).sort()).toEqual(["marley", "pitmans"]);
  });

  it("an alias holding a DIFFERENT value gives the brand two working credentials", () => {
    // Neither value is claimed by a second brand, so neither is ambiguous —
    // which is what makes a rotation possible without an outage.
    const env = { LEAD_INGEST_SECRET: MARLEY, LEAD_INGEST_SECRET_MARLEY: OTHER };
    const secrets = brandIngestSecrets(env);
    expect(resolveIngestBrand(`Bearer ${MARLEY}`, secrets)).toBe("marley");
    expect(resolveIngestBrand(`Bearer ${OTHER}`, secrets)).toBe("marley");
    expect(sharedIngestSecretBrands(env)).toEqual([]);
  });

  it("sharedIngestSecretBrands names every brand whose secret was refused", () => {
    expect(
      sharedIngestSecretBrands({
        LEAD_INGEST_SECRET: MARLEY,
        LEAD_INGEST_SECRET_PITMANS: MARLEY,
        LEAD_INGEST_SECRET_THIRD: OTHER,
      }).sort(),
    ).toEqual(["marley", "pitmans"]);
    expect(sharedIngestSecretBrands({ LEAD_INGEST_SECRET: MARLEY })).toEqual([]);
  });
});
