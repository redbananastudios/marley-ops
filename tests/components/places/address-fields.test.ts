import { describe, expect, it } from "vitest";
import { formatAddress } from "@/components/places/address-fields";

/**
 * formatAddress is the single joiner that builds leads.from_address /
 * to_address from the address-field state, so it is where the one-line form of
 * an address becomes canonical.
 *
 * It used to join the postcode verbatim while the server normalised the sibling
 * from_postcode / to_postcode column through formatUkPostcode. A customer
 * typing a postcode by hand (no Places autocomplete pick) therefore produced
 * two renderings of one value, side by side on the lead page: Route
 * "BH21 8NB" next to Pickup address "bh218nb" (QA-20260827-05).
 */
describe("formatAddress", () => {
  it("normalises a hand-typed postcode into the joined line", () => {
    expect(
      formatAddress({
        line1: "12 High Street",
        town: "Gillingham",
        county: "",
        postcode: "sp88ab",
        country: "United Kingdom",
      }),
    ).toBe("12 High Street, Gillingham, SP8 8AB");
  });

  it("leaves an already-canonical postcode untouched", () => {
    expect(
      formatAddress({
        line1: "1 The Lane",
        town: "Shaftesbury",
        county: "",
        postcode: "SP7 8AB",
        country: "United Kingdom",
      }),
    ).toBe("1 The Lane, Shaftesbury, SP7 8AB");
  });

  it("a blank postcode is still dropped, not rendered as an empty segment", () => {
    // formatUkPostcode returns "" for empty input, so the filter still removes
    // it and the joined line gains no stray comma.
    expect(
      formatAddress({ line1: "1 The Lane", town: "Shaftesbury", county: "", postcode: "", country: "" }),
    ).toBe("1 The Lane, Shaftesbury");
    expect(
      formatAddress({ line1: "", town: "", county: "", postcode: "   ", country: "" }),
    ).toBe("");
  });
});
