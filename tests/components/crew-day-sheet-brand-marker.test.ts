import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The web day sheet (/sheet/<token>) against its own emailed PDF.
 *
 * Two halves of one defect. The page rendered no per-job brand marker at all,
 * so a crew member working a mixed-brand day had nothing on screen saying which
 * company name to give at the door — while the PDF for that same day DID mark
 * the jobs, so the two documents for one day disagreed (PRD §4: "the sheet
 * itself is neutral and each job block carries its brand chip").
 *
 * And the assembly REFUSES a mixed-brand day whose brands read failed. That
 * refusal is written for the cron-driven PDF, where a missing sheet is visible
 * and the next run retries; on this page it replaced the crew member's working
 * document — addresses, access notes, the customer's phone — with the generic
 * error screen and a dashboard link they cannot use, to protect markers the
 * page never showed. The rule: degrade the marker, never the day.
 *
 * Source guards (node env, house convention): the marker gate is the PDF's,
 * byte for byte, and the assembly call is caught rather than allowed to escape.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("app/sheet/[token]/page.tsx");
const PDF = read("lib/crew-sheet/daily-docdef.ts");

/** The PDF's own gate, lifted from source so the two can never drift apart. */
const MULTI_BRAND_GATE = 'new Set(day.jobs.map((j) => j.brandShort ?? "")).size > 1';

describe("/sheet per-job brand marker", () => {
  it("uses the same mixed-day gate as the emailed PDF", () => {
    at(PDF, MULTI_BRAND_GATE, "the PDF's mixed-day gate (this test's premise)");
    at(SRC, MULTI_BRAND_GATE, "the page's mixed-day gate");
  });

  it("passes each job's brand short name into the job card", () => {
    const card = at(SRC, "function JobCard(", "the job card");
    const prop = SRC.indexOf("brandMark", card);
    expect(prop, "JobCard takes no brand marker prop").toBeGreaterThan(-1);
    at(SRC, "job.brandShort", "the per-job brand value");
  });

  it("shows the marker only on a mixed day", () => {
    // Single-brand days stay byte-identical (PRD §3.6), so the gate must sit
    // between the value and the render.
    at(SRC, "multiBrand ? job.brandShort ?? null : null", "the gated marker hand-off");
  });
});

describe("/sheet survives a failed brands read", () => {
  it("catches the assembly's refusal instead of letting it 500 the page", () => {
    const call = at(SRC, "assembleDaySheets(admin, row.work_date)", "the day assembly call");
    const tryAt = SRC.lastIndexOf("try {", call);
    expect(tryAt, "the assembly call is not inside a try block").toBeGreaterThan(-1);
    at(SRC, "} catch", "the catch arm");
  });

  it("says so rather than rendering as if it had loaded the day", () => {
    const note = at(SRC, "[crew-sheet]", "the visible degrade note");
    const consoleCall = at(SRC, "console.error(", "the console.error call");
    expect(consoleCall, "the note must ride console.error").toBeLessThan(note);
  });

  it("degrades to a page that still carries the office number", () => {
    at(SRC, "We can't load your sheet right now", "the degrade panel");
    // theme.phone/telHref, never a literal — this file is in the leak-scan
    // manifest and the sheet is a GROUP surface.
    at(SRC, "theme.telHref", "the office link on the degrade panel");
  });
});
