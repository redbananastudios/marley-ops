import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard over e2e `clients` seeds (QA-20260902-05).
 *
 * The QA-20260902-03 regression spec seeded its marker client with a
 * non-existent `clients.name` column — the real column is `display_name`
 * (migration 0001) — so its `beforeAll` threw "Could not find the 'name'
 * column of 'clients' in the schema cache" on every run, failing the whole
 * [crew] project across 8 consecutive staging CI runs before anyone looked.
 * Schema mismatches in e2e seeds only surface in the e2e job itself, which
 * the merge pipeline does not gate on; this scan catches the `clients` case
 * at vitest time instead.
 *
 * A text scan is enough here: every e2e `clients` insert in the repo is an
 * inline object literal, so "no `name:` key inside `.from("clients").insert({...})`"
 * is a per-file string fact.
 */

const E2E_ROOT = join(process.cwd(), "e2e");

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...specFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const clientsInserts = specFiles(E2E_ROOT).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const inserts = [...src.matchAll(/\.from\("clients"\)\s*\.insert\(\{([^}]*)\}/g)];
  return inserts.map((m) => ({ file: file.slice(process.cwd().length + 1), columns: m[1] }));
});

describe("e2e clients seeds use real columns", () => {
  it("finds the QA-20260902-03 spec's marker-client seed", () => {
    expect(
      clientsInserts.some((i) => i.file.endsWith("job-completion-status-consistency.spec.ts")),
    ).toBe(true);
  });

  it.each(clientsInserts)("$file seeds display_name, never the non-existent name column", ({ file, columns }) => {
    expect(columns, `${file}: clients has no \`name\` column — use display_name`).not.toMatch(
      /(^|[^_.\w])name\s*:/,
    );
    expect(columns, `${file}: a marker client needs display_name to be findable`).toMatch(
      /\bdisplay_name\s*:/,
    );
  });
});
