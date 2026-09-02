import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The diaries' bare-client pickers (clients with no enquiry yet — phone
 * callers added via /clients) read the clients table with a plain unbounded
 * select. PostgREST caps every unpaged response at 1000 rows, so past 1000
 * active clients the picker silently truncates: the missing client simply
 * is not offered, the office assumes they were never added, and a duplicate
 * gets created — no error anywhere. Every other clients picker (/storage)
 * already pages through fetchAllRows with the stable order + id pattern;
 * these two now match.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const pickerSpan = (src: string, page: string) => {
  const start = src.indexOf("bareClients");
  expect(start, `${page}: bare-client picker gone entirely`).toBeGreaterThan(-1);
  return src.slice(start, start + 600);
};

for (const page of [
  "app/(dashboard)/schedule/removals/page.tsx",
  "app/(dashboard)/schedule/surveys/page.tsx",
]) {
  describe(`${page} bare-client picker`, () => {
    const SRC = read(page);
    const PICKER = pickerSpan(SRC, page);

    it("pages the clients read through fetchAllRows", () => {
      at(PICKER, "fetchAllRows", "the paged read");
      at(PICKER, ".range(", "the range window");
      at(PICKER, '.order("id")', "the stable order + id tiebreaker");
    });
  });
}
