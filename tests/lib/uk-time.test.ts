import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ukDateShort } from "@/lib/uk-time";

/**
 * QA-20260826-03: /clients threw React #418 on every load — its `dateShort`
 * called toLocaleDateString WITHOUT a timeZone, so the server render (UTC)
 * and the browser (Europe/London) disagreed on the date for late-evening
 * timestamps through BST, and the text mismatch forced a client re-render of
 * the whole tree. The formatter now lives in lib/uk-time pinned to UK_TZ;
 * the wiring assertions keep the view on the shared helper.
 */

describe("ukDateShort (QA-20260826-03)", () => {
  it("formats a BST late-evening instant as its UK date, not the UTC one", () => {
    // 23:30 UTC on 25 Aug is 00:30 on 26 Aug in London (BST) — the exact
    // boundary where the un-pinned formatter hydration-mismatched on a UTC
    // server.
    expect(ukDateShort("2026-08-25T23:30:00Z")).toBe("26 Aug 2026");
  });

  it("agrees with UTC in winter, when London is on GMT", () => {
    expect(ukDateShort("2026-01-15T23:30:00Z")).toBe("15 Jan 2026");
  });

  it("formats a mid-day instant identically either side", () => {
    expect(ukDateShort("2026-08-25T12:00:00Z")).toBe("25 Aug 2026");
  });

  it("returns the em-dash placeholder for missing or unparseable input", () => {
    expect(ukDateShort(null)).toBe("—");
    expect(ukDateShort(undefined)).toBe("—");
    expect(ukDateShort("")).toBe("—");
    expect(ukDateShort("not-a-date")).toBe("—");
  });
});

describe("/clients wiring (QA-20260826-03)", () => {
  const source = readFileSync(
    join(__dirname, "../..", "components/clients/clients-view.tsx"),
    "utf8",
  );

  it("imports the UK_TZ-pinned formatter from lib/uk-time", () => {
    expect(source).toMatch(/import \{ ukDateShort(?: as \w+)? \} from "@\/lib\/uk-time"/);
  });

  it("has no un-pinned toLocaleDateString left to hydration-mismatch", () => {
    for (const call of source.match(/toLocaleDateString\([\s\S]*?\)/g) ?? []) {
      expect(call, `toLocaleDateString without timeZone: ${call}`).toMatch(/timeZone/);
    }
  });
});
