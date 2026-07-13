import { describe, expect, it } from "vitest";
import { groupLeadsByVariant } from "@/lib/growth/variants";

describe("groupLeadsByVariant", () => {
  it("groups by utm_content and counts won statuses", () => {
    const { rows, untagged } = groupLeadsByVariant([
      { utm_content: "lead-form-hero-red", status: "enquiry" },
      { utm_content: "lead-form-hero-red", status: "confirmed" },
      { utm_content: "lead-form-hero-red", status: "completed" },
      { utm_content: "story-hero-blue", status: "declined" },
      { utm_content: null, status: "enquiry" },
      { utm_content: "  ", status: "enquiry" },
    ]);
    expect(untagged).toBe(2);
    expect(rows).toEqual([
      { variant: "lead-form-hero-red", total: 3, won: 2, winRate: 67 },
      { variant: "story-hero-blue", total: 1, won: 0, winRate: 0 },
    ]);
  });

  it("sorts by volume then name and handles empty input", () => {
    expect(groupLeadsByVariant([])).toEqual({ rows: [], untagged: 0 });
    const { rows } = groupLeadsByVariant([
      { utm_content: "b", status: "enquiry" },
      { utm_content: "a", status: "enquiry" },
    ]);
    expect(rows.map((r) => r.variant)).toEqual(["a", "b"]);
  });
});
