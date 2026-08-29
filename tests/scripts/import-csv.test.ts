import { describe, expect, it } from "vitest";
import {
  headerReader,
  isoDate,
  money,
  normEmail,
  normMethod,
  parseCsv,
  phoneDigits,
  targetKind,
  ukTime,
  yes,
} from "../../scripts/lib/import-csv.mjs";

describe("parseCsv", () => {
  it("reads a plain sheet", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('ref,addr\nP-1,"14 Mill Lane, Blandford"\n')).toEqual([
      ["ref", "addr"],
      ["P-1", "14 Mill Lane, Blandford"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('note\n"He said ""no"" twice"\n')[1]).toEqual(['He said "no" twice']);
  });

  it("handles CRLF, bare CR and a missing trailing newline", () => {
    expect(parseCsv("a\r\n1\r\n")).toEqual([["a"], ["1"]]);
    expect(parseCsv("a\r1")).toEqual([["a"], ["1"]]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a newline that is inside quotes", () => {
    expect(parseCsv('note\n"line one\nline two"\n')[1]).toEqual(["line one\nline two"]);
  });

  it("drops entirely blank lines but keeps rows with empty cells", () => {
    expect(parseCsv("a,b\n\n1,\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  // Excel writes a BOM. Unstripped it becomes part of the FIRST header name,
  // so `col(row, "pitmans_ref")` silently returns "" for every row and the
  // importer reports "pitmans_ref is required" on a sheet that plainly has it.
  it("strips a UTF-8 BOM so the first column is still addressable", () => {
    const { col } = headerReader(parseCsv("﻿pitmans_ref,name\nP-1,Jane\n")[0]);
    expect(col(["P-1", "Jane"], "pitmans_ref")).toBe("P-1");
  });
});

describe("headerReader", () => {
  it("is case- and space-insensitive, and returns '' for absent columns", () => {
    const rows = parseCsv("Pitmans Ref,Customer Name\nP-1,Jane\n");
    const { col } = headerReader(rows[0]);
    expect(col(rows[1], "pitmans_ref")).toBe("P-1");
    expect(col(rows[1], "customer_name")).toBe("Jane");
    expect(col(rows[1], "not_a_column")).toBe("");
  });
});

describe("money", () => {
  it("reads plain, comma-grouped and £-prefixed amounts", () => {
    expect(money("1850")).toBe(1850);
    expect(money("1,850.50")).toBe(1850.5);
    expect(money("£1850.00")).toBe(1850);
    expect(money(" 720 ")).toBe(720);
  });

  it("rounds to pennies", () => {
    expect(money("10.005")).toBe(10.01);
  });

  // The reason this returns null rather than 0: a deposit of £100 mistyped as
  // "1O0" (letter O) must ERROR, not import as a £0 already-settled job.
  it("returns null for anything unreadable, never 0", () => {
    expect(money("1O0")).toBeNull();
    expect(money("n/a")).toBeNull();
    expect(money("--")).toBeNull();
  });

  it("returns null for an empty cell so callers can default deliberately", () => {
    expect(money("")).toBeNull();
    expect(money(null)).toBeNull();
  });
});

describe("isoDate", () => {
  it("passes ISO through and converts UK day-first", () => {
    expect(isoDate("2026-10-14")).toBe("2026-10-14");
    expect(isoDate("14/10/2026")).toBe("2026-10-14");
    expect(isoDate("1/2/2026")).toBe("2026-02-01");
  });

  it("returns null for empty or unreadable dates", () => {
    expect(isoDate("")).toBeNull();
    expect(isoDate("next Tuesday")).toBeNull();
    expect(isoDate("14-10-2026")).toBeNull();
  });
});

describe("ukTime", () => {
  // The whole reason this helper exists. A removal written as 08:00 UTC shows
  // on the crew's diary as 09:00 for the seven months the UK is on BST.
  it("puts 08:00 UK at 07:00Z during BST", () => {
    expect(ukTime("2026-10-14", 8)).toBe("2026-10-14T07:00:00.000Z");
  });

  it("puts 08:00 UK at 08:00Z during GMT", () => {
    expect(ukTime("2026-12-14", 8)).toBe("2026-12-14T08:00:00.000Z");
  });

  it("handles the same date either side of the October clock change", () => {
    expect(ukTime("2026-10-24", 8)).toBe("2026-10-24T07:00:00.000Z"); // BST
    expect(ukTime("2026-10-26", 8)).toBe("2026-10-26T08:00:00.000Z"); // GMT
  });
});

describe("yes / normEmail / phoneDigits / normMethod", () => {
  it("reads the affirmatives a human actually types", () => {
    for (const v of ["y", "Y", "yes", "TRUE", "1", "paid"]) expect(yes(v)).toBe(true);
    for (const v of ["", "n", "no", "false", "0", "maybe"]) expect(yes(v)).toBe(false);
  });

  it("lowercases and trims an email, and returns null for blank", () => {
    expect(normEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(normEmail("")).toBeNull();
  });

  it("normalises phones so 44- and 0- forms match each other", () => {
    expect(phoneDigits("+44 7700 900111")).toBe("07700900111");
    expect(phoneDigits("07700 900111")).toBe("07700900111");
    expect(phoneDigits("(01258) 858564")).toBe("01258858564");
  });

  it("maps payment wording to the stored method, null when unrecognised", () => {
    expect(normMethod("bank")).toBe("bank_transfer");
    expect(normMethod("BACS")).toBe("bank_transfer");
    expect(normMethod("Transfer")).toBe("bank_transfer");
    expect(normMethod("card")).toBe("card");
    expect(normMethod("cash")).toBe("cash");
    expect(normMethod("cheque")).toBeNull();
    expect(normMethod("")).toBeNull();
  });
});

describe("targetKind", () => {
  it("recognises hosted staging", () => {
    expect(targetKind("https://abcdefg.supabase.co")).toBe("staging");
  });

  it("recognises a local Supabase by port or hostname", () => {
    expect(targetKind("http://i9:54321")).toBe("local");
    expect(targetKind("http://localhost:54321")).toBe("local");
    expect(targetKind("http://127.0.0.1:3000")).toBe("local");
  });

  // The one that matters: anything else is production and must demand --prod.
  it("treats every other host as production", () => {
    expect(targetKind("https://ops.marleymoves.co.uk")).toBe("prod");
    expect(targetKind("https://supabase.example.com")).toBe("prod");
  });

  // A lookalike domain must not inherit staging's "no --prod needed" status.
  it("does not mistake a lookalike domain for hosted staging", () => {
    expect(targetKind("https://evil-supabase.co.attacker.test")).toBe("prod");
  });
});
