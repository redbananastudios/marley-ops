import { describe, expect, it } from "vitest";
import { REVIEW_LINKS, hasGoogleMailbox, selectReviewLink } from "@/lib/comms/review-platform";
import * as platformModule from "@/lib/comms/review-platform";

/**
 * Review-platform routing (Peter, 2026-08-19): Google-mailbox customers get
 * the Google link (a Google review needs a Google account), everyone else
 * Trustpilot, and a Checkatrade lead is asked on Checkatrade regardless.
 * The Google URL itself pins to the current GBP short link — the old
 * writereview?placeid=… form pointed at the wrong listing.
 */

const GOOGLE_URL = REVIEW_LINKS.google.url;

describe("REVIEW_LINKS canonical URLs", () => {
  it("Google is the current GBP short link, not the old placeid form", () => {
    expect(GOOGLE_URL).toBe("https://g.page/r/CXD_Yh4RUF1cEBM/review");
    expect(GOOGLE_URL).not.toContain("writereview");
  });

  it("Trustpilot is the write-a-review form, not the profile page", () => {
    expect(REVIEW_LINKS.trustpilot.url).toBe("https://uk.trustpilot.com/evaluate/marleymoves.co.uk");
  });
});

describe("hasGoogleMailbox", () => {
  it("matches gmail.com and legacy googlemail.com, case-insensitively", () => {
    expect(hasGoogleMailbox("jane@gmail.com")).toBe(true);
    expect(hasGoogleMailbox("Jane.Smith@GMAIL.COM")).toBe(true);
    expect(hasGoogleMailbox("old.timer@googlemail.com")).toBe(true);
  });

  it("rejects every other domain, including lookalikes", () => {
    expect(hasGoogleMailbox("jane@outlook.com")).toBe(false);
    expect(hasGoogleMailbox("jane@icloud.com")).toBe(false);
    expect(hasGoogleMailbox("jane@notgmail.com")).toBe(false);
    expect(hasGoogleMailbox("jane@gmail.com.evil.io")).toBe(false);
  });
});

describe("selectReviewLink", () => {
  it("gmail customer → Google, carrying the Settings URL", () => {
    expect(selectReviewLink("jane@gmail.com", "website", GOOGLE_URL)).toEqual({
      platform: "Google",
      url: GOOGLE_URL,
    });
  });

  it("a Settings override URL is what the Google ask carries", () => {
    const custom = "https://g.page/r/OVERRIDE/review";
    expect(selectReviewLink("jane@googlemail.com", null, custom).url).toBe(custom);
  });

  it("non-Google mailbox → Trustpilot", () => {
    expect(selectReviewLink("jane@outlook.com", "website", GOOGLE_URL)).toEqual({
      platform: "Trustpilot",
      url: "https://uk.trustpilot.com/evaluate/marleymoves.co.uk",
    });
  });

  it("Checkatrade lead → Checkatrade, even with a gmail address", () => {
    expect(selectReviewLink("jane@gmail.com", "checkatrade", GOOGLE_URL).platform).toBe("Checkatrade");
    expect(selectReviewLink("jane@outlook.com", "checkatrade", GOOGLE_URL).platform).toBe("Checkatrade");
  });
});

describe("selectBrandReviewLink — multi-brand routing (PRD §3.5)", () => {
  const { selectBrandReviewLink } = platformModule;

  it("the default brand keeps today's mailbox/channel routing exactly", () => {
    expect(selectBrandReviewLink({ slug: "marley", reviewUrl: null }, "marley", "jane@gmail.com", "website", GOOGLE_URL)).toEqual(
      selectReviewLink("jane@gmail.com", "website", GOOGLE_URL),
    );
    expect(selectBrandReviewLink({ slug: "marley", reviewUrl: null }, "marley", "jane@outlook.com", "checkatrade", GOOGLE_URL)?.platform).toBe(
      "Checkatrade",
    );
  });

  it("a non-default brand routes ONLY to its own review URL", () => {
    const link = selectBrandReviewLink(
      { slug: "pitmans", reviewUrl: "https://g.page/r/PITMANS/review" },
      "marley",
      // Even a Checkatrade-channel gmail customer: Marley's platform profiles
      // must never receive a Pitmans review.
      "jane@gmail.com",
      "checkatrade",
      GOOGLE_URL,
    );
    expect(link).toEqual({ platform: "Google", url: "https://g.page/r/PITMANS/review" });
  });

  it("a non-default brand with no review URL gets NO ask — never Marley's Settings URL", () => {
    expect(selectBrandReviewLink({ slug: "pitmans", reviewUrl: null }, "marley", "jane@gmail.com", "website", GOOGLE_URL)).toBeNull();
    expect(selectBrandReviewLink({ slug: "pitmans", reviewUrl: "   " }, "marley", "jane@gmail.com", "website", GOOGLE_URL)).toBeNull();
  });
});
