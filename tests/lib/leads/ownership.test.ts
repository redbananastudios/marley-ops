import { describe, expect, it } from "vitest";
import { isOwnedByEstimator, ownerEstimatorId } from "@/lib/leads/ownership";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("ownerEstimatorId", () => {
  it("explicit estimator_id wins over the survey estimator", () => {
    expect(ownerEstimatorId(ME, OTHER)).toBe(ME);
  });

  it("falls back to the survey estimator when there is no explicit owner", () => {
    expect(ownerEstimatorId(null, ME)).toBe(ME);
    expect(ownerEstimatorId(undefined, ME)).toBe(ME);
  });

  it("is null when neither signal is present", () => {
    expect(ownerEstimatorId(null, null)).toBeNull();
    expect(ownerEstimatorId(undefined, undefined)).toBeNull();
  });
});

describe("isOwnedByEstimator", () => {
  it("owned when explicitly assigned to me (even if the survey is someone else's)", () => {
    expect(isOwnedByEstimator(ME, ME, OTHER)).toBe(true);
  });

  it("owned when I did the survey and there is no explicit owner", () => {
    expect(isOwnedByEstimator(ME, null, ME)).toBe(true);
  });

  it("NOT owned when explicitly assigned to another estimator, even if I did the survey", () => {
    expect(isOwnedByEstimator(ME, OTHER, ME)).toBe(false);
  });

  it("NOT owned when the lead has no owner at all", () => {
    expect(isOwnedByEstimator(ME, null, null)).toBe(false);
  });

  it("a null/absent viewer never owns anything", () => {
    expect(isOwnedByEstimator(null, ME, ME)).toBe(false);
    expect(isOwnedByEstimator(undefined, null, ME)).toBe(false);
  });
});
