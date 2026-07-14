import { describe, expect, it } from "vitest";
import { parseAltRecipient } from "@/lib/comms/alt-recipient";

/** The office-directed "Send to" address is server-validated; the dialog only
 *  checks loosely. These lock the normalisation + validation contract. */
describe("parseAltRecipient", () => {
  it("returns email:null for empty / whitespace / undefined (no override)", () => {
    expect(parseAltRecipient(undefined)).toEqual({ ok: true, email: null });
    expect(parseAltRecipient(null)).toEqual({ ok: true, email: null });
    expect(parseAltRecipient("")).toEqual({ ok: true, email: null });
    expect(parseAltRecipient("   ")).toEqual({ ok: true, email: null });
  });

  it("trims and lowercases a valid address (same key the dedupe uses)", () => {
    expect(parseAltRecipient("  Jane.Doe@Example.CO.UK ")).toEqual({
      ok: true,
      email: "jane.doe@example.co.uk",
    });
  });

  it("accepts a plain valid address unchanged", () => {
    expect(parseAltRecipient("partner@example.com")).toEqual({
      ok: true,
      email: "partner@example.com",
    });
  });

  it("rejects a malformed address", () => {
    expect(parseAltRecipient("not-an-email").ok).toBe(false);
    expect(parseAltRecipient("jane@").ok).toBe(false);
    expect(parseAltRecipient("jane@example").ok).toBe(false);
    expect(parseAltRecipient("jane example@x.com").ok).toBe(false);
  });
});
