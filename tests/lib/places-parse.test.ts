import { describe, it, expect } from "vitest";
import { addressFromString, addressFromLead } from "@/lib/places/parse";

describe("addressFromString", () => {
  it("splits line1 / town / postcode when the string carries a postcode", () => {
    expect(addressFromString("Ash Cottage, Shaftesbury, SP7 9PX")).toEqual({
      line1: "Ash Cottage",
      town: "Shaftesbury",
      county: "",
      postcode: "SP7 9PX",
      country: "United Kingdom",
    });
  });

  it("keeps everything in line1 when there is no postcode to anchor the town", () => {
    expect(addressFromString("58 Stokehill, Trowbridge")).toEqual({
      line1: "58 Stokehill, Trowbridge",
      town: "",
      county: "",
      postcode: "",
      country: "United Kingdom",
    });
  });

  it("puts a bare outward code straight into postcode", () => {
    expect(addressFromString("SP7")).toEqual({ ...addressFromString(""), postcode: "SP7" });
  });

  it("reads a trailing UK county as county, not town", () => {
    // Pre-existing manual-lead convention (line1, town, county, postcode) — the
    // county must not be mislabelled as the town.
    expect(addressFromString("12 High Street, Bath, Somerset, BA1 2AB")).toEqual({
      line1: "12 High Street",
      town: "Bath",
      county: "Somerset",
      postcode: "BA1 2AB",
      country: "United Kingdom",
    });
  });

  it("does not treat a town that shares a city-name (Bristol) as a county", () => {
    expect(addressFromString("5 Park Row, Bristol, BS1 5LJ")).toEqual({
      line1: "5 Park Row",
      town: "Bristol",
      county: "",
      postcode: "BS1 5LJ",
      country: "United Kingdom",
    });
  });

  it("keeps a council-area-that-is-also-a-town (Stirling) as the town, not county", () => {
    // Stirling / Wrexham / Conwy name a council area AND a town — excluded from the
    // county gazetteer so the town is never blanked (would drop it from composeAddr).
    expect(addressFromString("10 King Street, Stirling, FK8 1AY")).toEqual({
      line1: "10 King Street",
      town: "Stirling",
      county: "",
      postcode: "FK8 1AY",
      country: "United Kingdom",
    });
  });
});

describe("addressFromLead", () => {
  // The reported bug: a website lead stores the street+town in the address line
  // and the postcode SEPARATELY — the seed must re-join them so the town and
  // postcode aren't dropped (Peter, 2026-08-02).
  it("re-joins a website lead's separate postcode so town + postcode fill", () => {
    expect(addressFromLead("58 Stokehill, Trowbridge", "BA14 7TJ")).toEqual({
      line1: "58 Stokehill",
      town: "Trowbridge",
      county: "",
      postcode: "BA14 7TJ",
      country: "United Kingdom",
    });
  });

  it("does NOT double a postcode a manual lead already baked into the address", () => {
    // from_address already ends with the postcode; the separate from_postcode
    // matches. The old naive re-append pushed the postcode into the Town field.
    expect(addressFromLead("58 Stokehill, Trowbridge, BA14 7TJ", "BA14 7TJ")).toEqual({
      line1: "58 Stokehill",
      town: "Trowbridge",
      county: "",
      postcode: "BA14 7TJ",
      country: "United Kingdom",
    });
  });

  it("splits town AND county when a website lead's address carries a county", () => {
    // edit-lead / Google-Places convention: from_address = line1, town, county
    // (no postcode), postcode stored separately. All four fields must land right.
    expect(addressFromLead("12 High Street, Bath, Somerset", "BA1 2AB")).toEqual({
      line1: "12 High Street",
      town: "Bath",
      county: "Somerset",
      postcode: "BA1 2AB",
      country: "United Kingdom",
    });
  });

  it("fills the postcode from a bare outward code without polluting line1", () => {
    expect(addressFromLead("58 Stokehill, Trowbridge", "SP7")).toEqual({
      line1: "58 Stokehill, Trowbridge",
      town: "",
      county: "",
      postcode: "SP7",
      country: "United Kingdom",
    });
  });

  it("handles a postcode-only website lead (empty address line)", () => {
    expect(addressFromLead("", "BA14 7TJ")).toEqual({
      line1: "",
      town: "",
      county: "",
      postcode: "BA14 7TJ",
      country: "United Kingdom",
    });
  });

  it("leaves a no-postcode-anywhere lead untouched (nothing to anchor)", () => {
    expect(addressFromLead("58 Stokehill, Trowbridge", "")).toEqual({
      line1: "58 Stokehill, Trowbridge",
      town: "",
      county: "",
      postcode: "",
      country: "United Kingdom",
    });
  });

  it("returns a blank address when both fields are empty", () => {
    expect(addressFromLead("", "")).toEqual({
      line1: "",
      town: "",
      county: "",
      postcode: "",
      country: "United Kingdom",
    });
  });
});
