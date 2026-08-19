import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

/**
 * The CSP is the outermost gate on every browser network call. These tests pin
 * the directives that carry uploads and rendering, so a future edit cannot
 * silently re-break them. Regression context: connect-src shipped without the
 * R2 origin while img/media-src had it, so presigned PUT uploads (AI survey
 * video/frames, crew job photos, expense receipts) were blocked by our own
 * header on every browser — found 2026-08-19 via a "storage error" on an AI
 * survey video upload, with zero objects ever landing in R2.
 */
describe("Content-Security-Policy", () => {
  async function csp(): Promise<string> {
    const rules = await nextConfig.headers!();
    const header = rules[0]?.headers.find((h) => h.key === "Content-Security-Policy");
    if (!header) throw new Error("CSP header missing from next.config headers()");
    return header.value;
  }

  function directive(value: string, name: string): string {
    const found = value.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    if (!found) throw new Error(`${name} directive missing from CSP`);
    return found;
  }

  const R2 = "https://*.r2.cloudflarestorage.com";

  it("allows XHR/fetch to R2 — presigned uploads live or die on connect-src", async () => {
    expect(directive(await csp(), "connect-src")).toContain(R2);
  });

  it("keeps R2 renderable in img-src and media-src (signed GET display)", async () => {
    const value = await csp();
    expect(directive(value, "img-src")).toContain(R2);
    expect(directive(value, "media-src")).toContain(R2);
  });

  it("keeps blob: in media-src and worker-src (capture preview + pdf worker)", async () => {
    const value = await csp();
    expect(directive(value, "media-src")).toContain("blob:");
    expect(directive(value, "worker-src")).toContain("blob:");
  });
});
