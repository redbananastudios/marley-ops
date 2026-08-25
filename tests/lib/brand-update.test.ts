import { describe, expect, it } from "vitest";
import { sanitizeBrandUpdate, type SafeBrandUpdate } from "@/lib/brand-update";

/** The whole point of the helper: this is the ONLY set of keys that can ever
 *  reach the brands update, whatever the client sends. */
const SAFE_KEYS: (keyof SafeBrandUpdate)[] = [
  "phone",
  "address",
  "review_url",
  "terms_url",
  "colour_primary",
  "colour_accent",
  "logo_url",
  "card_payments_enabled",
];

const valid = {
  phone: "01258 858564",
  address: "Uplands Business Park, Blandford Forum, Dorset DT11 7UZ",
  reviewUrl: "https://g.page/r/abc/review",
  termsUrl: "https://pitmansremovals.co.uk/terms",
  logoUrl: "https://pitmansremovals.co.uk/logo.png",
  colourPrimary: "#1D4ED8",
  colourAccent: "#FACC15",
  cardPaymentsEnabled: false,
};

describe("sanitizeBrandUpdate — the server-side safe-field whitelist", () => {
  it("passes valid input through as the snake_case update object", () => {
    const res = sanitizeBrandUpdate(valid);
    expect(res).toEqual({
      ok: true,
      update: {
        phone: "01258 858564",
        address: "Uplands Business Park, Blandford Forum, Dorset DT11 7UZ",
        review_url: "https://g.page/r/abc/review",
        terms_url: "https://pitmansremovals.co.uk/terms",
        logo_url: "https://pitmansremovals.co.uk/logo.png",
        colour_primary: "#1D4ED8",
        colour_accent: "#FACC15",
        card_payments_enabled: false,
      },
    });
  });

  it("strips smuggled structural fields — slug, active, ref_prefix, name and friends never reach the update", () => {
    const res = sanitizeBrandUpdate({
      ...valid,
      // A hostile/buggy client trying to rename, re-prefix and self-activate:
      slug: "marley",
      active: true,
      ref_prefix: "XX",
      refPrefix: "XX",
      name: "Evil Brand",
      short_name: "Evil",
      initial: "E",
      legal_line: "Evil Ltd",
      group_line: "",
      email_domain: "evil.example",
      hello_from: "hello@evil.example",
      accounts_from: "accounts@evil.example",
      reply_domain: "reply.evil.example",
      sms_sender: "EVIL",
      ledger_branding_id: "theme-1",
      resend_template_ids: { deposit_request: "tpl_evil" },
      sort_order: -1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Exactly the whitelist, nothing else — the update is BUILT, never spread.
    expect(Object.keys(res.update).sort()).toEqual([...SAFE_KEYS].sort());
    expect(res.update).not.toHaveProperty("slug");
    expect(res.update).not.toHaveProperty("active");
    expect(res.update).not.toHaveProperty("ref_prefix");
    expect(res.update).not.toHaveProperty("name");
    expect(res.update).not.toHaveProperty("sort_order");
  });

  it("trims strings and turns empty strings into null (clearing a field)", () => {
    const res = sanitizeBrandUpdate({
      ...valid,
      phone: "  01747 637070  ",
      address: "",
      reviewUrl: "   ",
      termsUrl: "  https://marleymoves.co.uk/terms-conditions/  ",
      logoUrl: "",
      colourPrimary: " #C03838 ",
      colourAccent: "",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.update.phone).toBe("01747 637070");
    expect(res.update.address).toBeNull();
    expect(res.update.review_url).toBeNull();
    expect(res.update.terms_url).toBe("https://marleymoves.co.uk/terms-conditions/");
    expect(res.update.logo_url).toBeNull();
    expect(res.update.colour_primary).toBe("#C03838");
    expect(res.update.colour_accent).toBeNull();
  });

  it("treats missing / null optional fields as null", () => {
    const res = sanitizeBrandUpdate({ cardPaymentsEnabled: true, phone: null });
    expect(res).toEqual({
      ok: true,
      update: {
        phone: null,
        address: null,
        review_url: null,
        terms_url: null,
        colour_primary: null,
        colour_accent: null,
        logo_url: null,
        card_payments_enabled: true,
      },
    });
  });

  it.each(["C03838", "#C0383", "#C038388", "#C0383G", "red", "#c038", "rgb(1,2,3)"])(
    "rejects bad hex %j",
    (hex) => {
      expect(sanitizeBrandUpdate({ ...valid, colourPrimary: hex }).ok).toBe(false);
      expect(sanitizeBrandUpdate({ ...valid, colourAccent: hex }).ok).toBe(false);
    },
  );

  it("accepts lower/upper/mixed-case hex", () => {
    for (const hex of ["#c03838", "#C03838", "#c0A8f9"]) {
      const res = sanitizeBrandUpdate({ ...valid, colourPrimary: hex });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.update.colour_primary).toBe(hex);
    }
  });

  it.each(["http://insecure.example", "javascript:alert(1)", "ftp://x", "not a url"])(
    "rejects non-https URLs %j on every URL field",
    (url) => {
      expect(sanitizeBrandUpdate({ ...valid, reviewUrl: url }).ok).toBe(false);
      expect(sanitizeBrandUpdate({ ...valid, termsUrl: url }).ok).toBe(false);
      expect(sanitizeBrandUpdate({ ...valid, logoUrl: url }).ok).toBe(false);
    },
  );

  it("rejects wrong types instead of coercing them", () => {
    expect(sanitizeBrandUpdate({ ...valid, phone: 1258858564 }).ok).toBe(false);
    expect(sanitizeBrandUpdate({ ...valid, address: ["x"] }).ok).toBe(false);
    expect(sanitizeBrandUpdate({ ...valid, colourPrimary: { hex: "#C03838" } }).ok).toBe(false);
  });

  it("requires the card-payments switch to be an explicit boolean — never defaulted", () => {
    // Defaulting either way would silently flip a live payment channel.
    const withoutToggle: Record<string, unknown> = { ...valid };
    delete withoutToggle.cardPaymentsEnabled;
    expect(sanitizeBrandUpdate(withoutToggle).ok).toBe(false);
    expect(sanitizeBrandUpdate({ ...valid, cardPaymentsEnabled: "true" }).ok).toBe(false);
    expect(sanitizeBrandUpdate({ ...valid, cardPaymentsEnabled: 1 }).ok).toBe(false);
    const res = sanitizeBrandUpdate({ ...valid, cardPaymentsEnabled: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.update.card_payments_enabled).toBe(true);
  });

  it("rejects over-length values", () => {
    expect(sanitizeBrandUpdate({ ...valid, phone: "9".repeat(51) }).ok).toBe(false);
    expect(sanitizeBrandUpdate({ ...valid, address: "a".repeat(501) }).ok).toBe(false);
    expect(
      sanitizeBrandUpdate({ ...valid, logoUrl: `https://x.example/${"a".repeat(500)}` }).ok,
    ).toBe(false);
  });
});
