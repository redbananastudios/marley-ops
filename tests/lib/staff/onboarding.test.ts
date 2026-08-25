import { describe, expect, it } from "vitest";
import {
  ageFromDob,
  formatSubmissionAddress,
  isUkPhone,
  normalisePhone,
  staffFieldsFromSubmission,
  staffSubmissionSchema,
} from "@/lib/staff/onboarding";

const TODAY = new Date(Date.UTC(2026, 6, 29)); // 29 Jul 2026

const valid = {
  full_name: "Jack Smith",
  date_of_birth: "1998-03-14",
  address_line1: "1 High Street",
  address_town: "Shaftesbury",
  address_postcode: "SP7 8AA",
  email: "Jack.Smith@Example.com",
  phone: "07572 382366",
  is_driver: true,
  emergency_contact_name: "Sarah Smith",
  emergency_contact_phone: "07572 111222",
  notes: "Clean licence.",
};

describe("normalisePhone", () => {
  it("folds formatting and +44 onto one comparable shape (the approve dedupe relies on this)", () => {
    expect(normalisePhone("07572 382366")).toBe("07572382366");
    expect(normalisePhone("07572-382-366")).toBe("07572382366");
    expect(normalisePhone("+44 7572 382366")).toBe("07572382366");
    expect(normalisePhone("447572382366")).toBe("07572382366");
    expect(normalisePhone("(07572) 382366")).toBe("07572382366");
  });

  it("treats empty as empty (no accidental match on two blank phones)", () => {
    expect(normalisePhone("")).toBe("");
    expect(normalisePhone(null)).toBe("");
    expect(normalisePhone(undefined)).toBe("");
  });
});

describe("ageFromDob", () => {
  it("counts full years, respecting whether the birthday has passed", () => {
    expect(ageFromDob("1998-03-14", TODAY)).toBe(28); // birthday passed
    expect(ageFromDob("1998-12-25", TODAY)).toBe(27); // birthday still to come
    expect(ageFromDob("2010-07-29", TODAY)).toBe(16); // 16th birthday today
  });

  it("returns null for garbage and impossible dates", () => {
    expect(ageFromDob("not-a-date", TODAY)).toBeNull();
    expect(ageFromDob("1998-02-31", TODAY)).toBeNull(); // rollover, not a real day
  });
});

describe("isUkPhone", () => {
  it("accepts common UK shapes and rejects junk", () => {
    expect(isUkPhone("07572 382366")).toBe(true);
    expect(isUkPhone("+44 7572 382366")).toBe(true);
    expect(isUkPhone("01747 637070")).toBe(true);
    expect(isUkPhone("12345")).toBe(false);
    expect(isUkPhone("call me")).toBe(false);
  });
});

describe("staffSubmissionSchema", () => {
  it("accepts a valid submission and normalises the email to lowercase", () => {
    const res = staffSubmissionSchema.safeParse(valid);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.email).toBe("jack.smith@example.com");
      expect(res.data.is_driver).toBe(true);
    }
  });

  it("rejects a bad email", () => {
    const res = staffSubmissionSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(res.success).toBe(false);
  });

  it("rejects an applicant aged 12 (and one over 80)", () => {
    const thisYear = new Date().getUTCFullYear();
    expect(staffSubmissionSchema.safeParse({ ...valid, date_of_birth: `${thisYear - 12}-01-01` }).success).toBe(false);
    expect(staffSubmissionSchema.safeParse({ ...valid, date_of_birth: "1930-01-01" }).success).toBe(false);
  });

  it("bounds free text — notes are sliced to 1000 characters, never rejected", () => {
    const res = staffSubmissionSchema.safeParse({ ...valid, notes: "x".repeat(5000) });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.notes).toHaveLength(1000);
  });

  it("requires a plausible UK postcode and uppercases it", () => {
    expect(staffSubmissionSchema.safeParse({ ...valid, address_postcode: "" }).success).toBe(false);
    expect(staffSubmissionSchema.safeParse({ ...valid, address_postcode: "not a code" }).success).toBe(false);
    const res = staffSubmissionSchema.safeParse({ ...valid, address_postcode: "sp7 8aa" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.address_postcode).toBe("SP7 8AA");
  });

  it("re-spaces a postcode typed without the internal space (QA-20260825-01)", () => {
    for (const [typed, stored] of [
      ["sp71ab", "SP7 1AB"], // no space at all
      ["SW1A1AA", "SW1A 1AA"], // longest outward code, no space
      ["m11ae", "M1 1AE"], // shortest outward code, no space
    ] as const) {
      const res = staffSubmissionSchema.safeParse({ ...valid, address_postcode: typed });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.address_postcode).toBe(stored);
    }
  });

  it("rejects separators the validator does not allow, rather than silently re-spacing them", () => {
    // UK_POSTCODE_RE permits at most ONE internal space and no punctuation, so
    // these never reach the transform at all — worth pinning, because it is the
    // validator (not the formatter) that decides, and a future loosening of the
    // regex would silently change what gets stored.
    for (const typed of ["SP7-1AB", "sp7.1ab", "SP7  1AB"]) {
      expect(staffSubmissionSchema.safeParse({ ...valid, address_postcode: typed }).success).toBe(false);
    }
  });

  it("requires a street address; town is optional", () => {
    expect(staffSubmissionSchema.safeParse({ ...valid, address_line1: "  " }).success).toBe(false);
    expect(staffSubmissionSchema.safeParse({ ...valid, address_town: "" }).success).toBe(true);
  });
});

describe("formatSubmissionAddress", () => {
  it("joins line1, town and postcode, skipping blanks", () => {
    expect(
      formatSubmissionAddress({ address_line1: "1 High Street", address_town: "Shaftesbury", address_postcode: "SP7 8AA" }),
    ).toBe("1 High Street, Shaftesbury, SP7 8AA");
    expect(
      formatSubmissionAddress({ address_line1: "1 High Street", address_town: "", address_postcode: "SP7 8AA" }),
    ).toBe("1 High Street, SP7 8AA");
  });
});

describe("staffFieldsFromSubmission", () => {
  it("maps submission fields onto the staff row, turning empty strings into null", () => {
    expect(
      staffFieldsFromSubmission({
        full_name: "Jack Smith",
        date_of_birth: "1998-03-14",
        address: "",
        email: "jack.smith@example.com",
        phone: null,
        is_driver: false,
        emergency_contact_name: "",
        emergency_contact_phone: null,
      }),
    ).toEqual({
      full_name: "Jack Smith",
      phone: null,
      email: "jack.smith@example.com",
      address: null,
      date_of_birth: "1998-03-14",
      emergency_contact_name: null,
      emergency_contact_phone: null,
      is_driver: false,
    });
  });
});
