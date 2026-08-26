import { afterEach, describe, expect, it } from "vitest";
import { templateIdFor } from "@/lib/comms/template-id";
import { mapBrand } from "@/lib/brand";

const ENV = "RESEND_TEMPLATE_QUOTE_EMAIL";

const pitmansWith = (ids: Record<string, string>) =>
  mapBrand({ slug: "pitmans", name: "Pitmans Removals & Storage", resend_template_ids: ids });

afterEach(() => {
  delete process.env[ENV];
});

describe("templateIdFor — env fallback is Marley-only (PRD §11.7 trap 4)", () => {
  it("marley (and no brand at all) resolves the env var exactly as today", () => {
    process.env[ENV] = "tmpl_marley_quote";
    const marley = mapBrand({ slug: "marley", name: "Marley Moves" });
    expect(templateIdFor(marley, ENV)).toBe("tmpl_marley_quote");
    expect(templateIdFor(null, ENV)).toBe("tmpl_marley_quote");
    expect(templateIdFor(undefined, ENV)).toBe("tmpl_marley_quote");
  });

  it("unset env var stays undefined for marley — the inline-HTML path is unchanged", () => {
    expect(templateIdFor(null, ENV)).toBeUndefined();
  });

  it("a non-default brand reads its own id from resend_template_ids", () => {
    process.env[ENV] = "tmpl_marley_quote";
    expect(templateIdFor(pitmansWith({ [ENV]: "tmpl_pitmans_quote" }), ENV)).toBe("tmpl_pitmans_quote");
  });

  it("a non-default brand missing the key NEVER borrows Marley's env template", () => {
    process.env[ENV] = "tmpl_marley_quote";
    expect(templateIdFor(pitmansWith({}), ENV)).toBeUndefined();
    // group comms send as Marley (§11.10) via null/undefined; the row itself
    // carries no ids, so passing it degrades to inline HTML, never cross-brand
    expect(templateIdFor(mapBrand({ slug: "group", name: "Marley Group" }), ENV)).toBeUndefined();
  });
});
