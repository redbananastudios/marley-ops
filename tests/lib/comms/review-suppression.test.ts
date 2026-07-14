import { describe, expect, it } from "vitest";
import { exceptionsWarrantReviewSuppression } from "@/lib/comms/review-suppression";

/** The auto-suppress rule: any real (non-empty, trimmed) exceptions note at
 *  completion sign-off switches the post-move review ask off. Absence with an
 *  empty note must NOT suppress. */
describe("exceptionsWarrantReviewSuppression", () => {
  it("suppresses when a real exceptions note is present", () => {
    expect(exceptionsWarrantReviewSuppression("Scratched the sideboard")).toBe(true);
    expect(exceptionsWarrantReviewSuppression("  minor delay  ")).toBe(true);
  });

  it("does NOT suppress for empty / whitespace-only / missing notes", () => {
    expect(exceptionsWarrantReviewSuppression("")).toBe(false);
    expect(exceptionsWarrantReviewSuppression("   ")).toBe(false);
    expect(exceptionsWarrantReviewSuppression("\n\t ")).toBe(false);
    expect(exceptionsWarrantReviewSuppression(null)).toBe(false);
    expect(exceptionsWarrantReviewSuppression(undefined)).toBe(false);
  });
});
