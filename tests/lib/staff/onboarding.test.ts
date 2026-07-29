import { describe, expect, it } from "vitest";
import {
  ageFromDob,
  isUkPhone,
  normalisePhone,
  staffFieldsFromSubmission,
  staffSubmissionSchema,
} from "@/lib/staff/onboarding";

const TODAY = new Date(Date.UTC(2026, 6, 29)); // 29 Jul 2026

const valid = {
  full_name: "Jack Smith",
  date_of_birth: "1998-03-14",
  address: "1 High Street, Shaftesbury, SP7 8AA",
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
