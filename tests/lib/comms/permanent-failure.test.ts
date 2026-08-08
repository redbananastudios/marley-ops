import { describe, expect, it } from "vitest";

import { isPermanentProviderError } from "@/lib/comms/permanent-failure";

describe("isPermanentProviderError", () => {
  it("recognises the exact failure that cost MMR034 its confirmation", () => {
    expect(
      isPermanentProviderError("The `template, variables, value` field has a 2,000 character limit per value."),
    ).toBe(true);
  });

  it("recognises malformed-request rejections", () => {
    for (const e of [
      "validation_error: to is required",
      "Invalid `to` field",
      "recipient must be a valid email address",
      "Attachment too large",
    ]) {
      expect(isPermanentProviderError(e)).toBe(true);
    }
  });

  it("keeps retrying anything transient — an outage is what the ladder is FOR", () => {
    for (const e of [
      "The operation was aborted due to timeout",
      "Resend error 500",
      "Too many requests",
      "fetch failed",
      "socket hang up",
      null,
      undefined,
      "",
    ]) {
      expect(isPermanentProviderError(e)).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isPermanentProviderError("CHARACTER LIMIT exceeded")).toBe(true);
  });
});
