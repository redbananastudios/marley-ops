import { describe, expect, it } from "vitest";
import { editLeadSchema } from "@/lib/leads/schema";

const base = {
  name: "Stephen Bull",
  phone: "07990558617",
  email: "stephen.m.bull@hotmail.com",
  from_postcode: "BH21 8NB",
  to_postcode: "TA13 5DJ",
  from_address: "Greenlands Farm, Horton Road, Wimborne",
  to_address: "",
  property_size: "3 bedroom",
  preferred_date: "",
  estimate_given: "",
  referral_commission: "",
  notes: "",
};

describe("editLeadSchema", () => {
  it("keeps empty money fields as '' — never coerces them to 0", () => {
    // z.coerce.number() turns "" into 0, so with the number branch first every
    // save of an untouched estimate stored £0 ("Estimate given £0" on leads
    // that never had one — found 2026-08-14). The action maps "" → null.
    const v = editLeadSchema.parse(base);
    expect(v.estimate_given).toBe("");
    expect(v.referral_commission).toBe("");
  });

  it("still accepts real amounts, including numeric strings", () => {
    const v = editLeadSchema.parse({ ...base, estimate_given: "950", referral_commission: 50 });
    expect(v.estimate_given).toBe(950);
    expect(v.referral_commission).toBe(50);
  });

  it("rejects negative amounts and junk", () => {
    expect(editLeadSchema.safeParse({ ...base, estimate_given: -1 }).success).toBe(false);
    expect(editLeadSchema.safeParse({ ...base, estimate_given: "abc" }).success).toBe(false);
  });

  it("accepts the postcode-only edit that motivated all of this", () => {
    expect(editLeadSchema.safeParse(base).success).toBe(true);
  });

  it("normalises names and postcodes on parse (2026-08-14 formatting rules)", () => {
    const v = editLeadSchema.parse({ ...base, name: "paul betty", from_postcode: "bh218nb" });
    expect(v.name).toBe("Paul Betty");
    expect(v.from_postcode).toBe("BH21 8NB");
  });

  it("accepts the provisional window fields and rejects junk tiers", () => {
    const v = editLeadSchema.parse({
      ...base,
      to_property_size: "2 bedroom",
      approx_month: "2026-09",
      approx_window: "mid",
    });
    expect(v.to_property_size).toBe("2 bedroom");
    expect(v.approx_month).toBe("2026-09");
    expect(v.approx_window).toBe("mid");
    expect(editLeadSchema.safeParse({ ...base, approx_window: "middle" }).success).toBe(false);
  });

  it("stale dialogs that omit the new fields leave them undefined (write-guarded)", () => {
    const v = editLeadSchema.parse(base);
    expect(v.to_property_size).toBeUndefined();
    expect(v.approx_month).toBeUndefined();
    expect(v.approx_window).toBeUndefined();
  });
});
