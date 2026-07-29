import { describe, expect, it } from "vitest";
import { likeEscape } from "@/lib/util/like";

describe("likeEscape", () => {
  it("escapes underscore, percent and backslash so ILIKE matches literally", () => {
    // Without escaping, `_` is a single-char wildcard — the security bug this fixes.
    expect(likeEscape("a_b@x.com")).toBe("a\\_b@x.com");
    expect(likeEscape("50%@x.com")).toBe("50\\%@x.com");
    expect(likeEscape("a\\b@x.com")).toBe("a\\\\b@x.com");
  });

  it("leaves an ordinary email untouched (no-op when there are no wildcards)", () => {
    expect(likeEscape("e2e-office@marleymoves.test")).toBe("e2e-office@marleymoves.test");
    expect(likeEscape("connor@marleymoves.co.uk")).toBe("connor@marleymoves.co.uk");
  });
});
