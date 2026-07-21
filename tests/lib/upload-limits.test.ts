import { describe, expect, it } from "vitest";
import {
  isValidDeclaredUploadSize,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@/lib/storage/upload-limits";

describe("declared upload sizes", () => {
  it("accepts positive safe integers up to the configured cap", () => {
    expect(isValidDeclaredUploadSize(1, MAX_IMAGE_UPLOAD_BYTES)).toBe(true);
    expect(isValidDeclaredUploadSize(MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_BYTES)).toBe(true);
  });

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, MAX_IMAGE_UPLOAD_BYTES + 1])(
    "rejects an absent, invalid, or over-cap size (%s)",
    (bytes) => {
      expect(isValidDeclaredUploadSize(bytes, MAX_IMAGE_UPLOAD_BYTES)).toBe(false);
    },
  );
});
