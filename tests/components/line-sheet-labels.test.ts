import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QA-20260825-04: the "Add a line" sheets rendered their <label>s as plain
 * siblings — no htmlFor/id link — so screen readers announced the inputs as
 * unlabelled edit fields and getByLabel() found nothing. Every label in these
 * editors must reference an input id, and every input must carry that id.
 */

const EDITORS = [
  "components/estimator/estimator-statement-editor.tsx",
  "components/my-jobs/statement-editor.tsx",
];

// Non-greedy up to the closing "/>" / ">" — attribute values here never contain
// those sequences, while "[^>]*" would stop early at onChange's "=>".
const LABEL_TAG = /<label\b[\s\S]*?>/g;
const INPUT_TAG = /<input\b[\s\S]*?\/>/g;
const HTML_FOR_VALUE = /htmlFor=\{`([^`]+)`\}/;
const ID_VALUE = /\bid=\{`([^`]+)`\}/;

describe.each(EDITORS)("%s LineSheet labels (QA-20260825-04)", (file) => {
  const source = readFileSync(join(__dirname, "../..", file), "utf8");
  const labels = source.match(LABEL_TAG) ?? [];
  const inputs = source.match(INPUT_TAG) ?? [];

  it("has the label/input pairs the sheet renders", () => {
    expect(labels.length).toBeGreaterThan(0);
    expect(inputs.length).toBe(labels.length);
  });

  it("gives every <label> an htmlFor", () => {
    for (const tag of labels) {
      expect(tag, `label without htmlFor: ${tag}`).toMatch(/htmlFor=/);
    }
  });

  it("gives every <input> an id", () => {
    for (const tag of inputs) {
      expect(tag, `input without id: ${tag}`).toMatch(/\bid=\{/);
    }
  });

  it("pairs each htmlFor with a matching input id", () => {
    const htmlFors = labels
      .map((tag) => HTML_FOR_VALUE.exec(tag)?.[1])
      .filter((v): v is string => Boolean(v));
    const ids = inputs
      .map((tag) => ID_VALUE.exec(tag)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(htmlFors.length).toBe(labels.length);
    expect([...ids].sort()).toEqual([...htmlFors].sort());
  });
});
