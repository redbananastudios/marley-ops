import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the 2026-08-08 notes bug (Peter: "I added some notes to
 * the survey, and they did not persist").
 *
 * `appointments.notes` was written by the booking dialog but omitted from every
 * schedule page's `.select(...)`. The calendar payload therefore carried
 * `notes: null`, the edit dialog seeded its textarea blank, and saving wrote
 * that blank back — so notes were invisible everywhere AND silently destroyed
 * the next time anyone opened and saved the dialog. Live prod had 6
 * appointments and zero surviving notes.
 *
 * The bug is a broken round-trip, which type-checking cannot see: every
 * individual piece was well-typed. These are source-level contracts because the
 * failure lives in what a query does NOT ask for.
 */

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Pages whose appointment rows reach an editable dialog. */
const PAGES_FEEDING_AN_EDIT_DIALOG = [
  "app/(dashboard)/schedule/surveys/page.tsx",
  "app/(dashboard)/schedule/removals/page.tsx",
  "app/(dashboard)/schedule/page.tsx",
];

/** Components that build an EditTarget handed to AppointmentDialog. */
const EDIT_TARGET_BUILDERS = [
  "components/schedule/scheduler-view.tsx",
  "components/schedule/schedule-allocation-view.tsx",
];

describe("appointment notes round-trip", () => {
  it.each(PAGES_FEEDING_AN_EDIT_DIALOG)("%s selects notes from appointments", (page) => {
    const src = read(page);
    // Isolate the appointments query so a `notes` column on another table
    // (leads.notes, storage lets) cannot satisfy this by accident.
    const start = src.indexOf('.from("appointments")');
    expect(start, `${page} no longer queries appointments — update this contract`).toBeGreaterThan(-1);
    const selectStart = src.indexOf(".select(", start);
    const query = src.slice(selectStart, selectStart + 400);
    expect(query, `${page} must select notes, or the edit dialog seeds blank and saving wipes them`).toMatch(
      /notes/,
    );
  });

  it.each(EDIT_TARGET_BUILDERS)("%s never hardcodes a null notes into an edit target", (file) => {
    const src = read(file);
    // The exact shape of the original bug: a literal null standing in for data
    // the payload could have carried.
    expect(src, `${file} must pass the real notes through, not a null placeholder`).not.toMatch(
      /notes:\s*null\s*,?\s*(\/\/|$)/m,
    );
  });

  it("the edit dialog only sends notes when they changed", () => {
    const src = read("components/schedule/appointment-dialog.tsx");
    // updateAppointment treats a supplied empty string as "clear it", so an
    // unchanged (or never-loaded) field must be absent from the patch entirely.
    // This is the second line of defence: even if a payload loses notes again,
    // an unrelated edit cannot wipe them.
    expect(src).toMatch(/notesChanged\s*=\s*notes\s*!==\s*\(edit\.notes\s*\?\?\s*""\)/);
    expect(src).toMatch(/\.\.\.\(notesChanged\s*\?\s*\{\s*notes\s*\}\s*:\s*\{\}\)/);
  });

  it("the server still distinguishes 'not supplied' from 'cleared'", () => {
    const src = read("app/(dashboard)/schedule/actions.ts");
    // `patch.notes !== undefined` is what makes the omit-when-unchanged fix
    // work. If this ever becomes an unconditional write, the guard above is
    // silently pointless.
    expect(src).toMatch(/patch\.notes\s*!==\s*undefined/);
  });
});
