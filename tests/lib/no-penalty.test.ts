/**
 * Payments Policy v2 hard copy rule (docs/payments-policy-v2-prd.md §1):
 * the word "penalty" never appears — terms, /q, emails, UI. Framing is always
 * "held against your original date — refunded in full if we re-book it."
 *
 * This test walks every source file on the policy's surfaces (comms builders,
 * booking/quote/refund components, the /refunds page, the Resend template
 * registry) and asserts /penalt/i appears NOWHERE outside comments. Comments
 * are stripped first because several files document this very ban ("the word
 * \"penalty\" never appears…") — the enforceable invariant is that no STRING
 * LITERAL, JSX text, template HTML or identifier carries it, i.e. nothing that
 * can ever be rendered or emailed. This file itself is excluded.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const WALK_DIRS = [
  "lib/comms",
  "components/bookings",
  "components/quote",
  "components/refunds", // does not exist today; walked defensively
  "components/dashboard",
  "app/(dashboard)/refunds",
];

const EXTRA_FILES = [
  // Customer-facing template HTML lives here too — same ban applies.
  "scripts/create-resend-templates.mjs",
];

const EXTENSIONS = [".ts", ".tsx", ".mjs"];
const SELF = join(ROOT, "tests", "lib", "no-penalty.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => full.endsWith(ext)) && full !== SELF) out.push(full);
  }
  return out;
}

/**
 * Remove // line and /* block *\/ comments while preserving string and
 * template-literal contents (where the banned word would actually render).
 * A `//` inside a string (e.g. a URL) is correctly kept as string content.
 */
function stripComments(src: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        i += 2;
      } else if (c === "/" && next === "*") {
        mode = "block";
        i += 2;
      } else {
        if (c === "'") mode = "single";
        else if (c === '"') mode = "double";
        else if (c === "`") mode = "template";
        out += c;
        i++;
      }
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // Inside a string/template literal: keep everything, honour escapes.
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if (
      (mode === "single" && c === "'") ||
      (mode === "double" && c === '"') ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i++;
  }
  return out;
}

describe("payments policy v2: the word 'penalty' never appears", () => {
  const files = [
    ...WALK_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...EXTRA_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)),
  ];

  it("walks a non-trivial surface (sanity)", () => {
    // If the walk ever collapses to nothing the assertions below would
    // vacuously pass — fail loudly instead.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [relative(ROOT, f), f] as const))(
    "%s carries no renderable 'penalty'",
    (_rel, full) => {
      const withoutComments = stripComments(readFileSync(full, "utf8"));
      const match = withoutComments.match(/.{0,60}penalt.{0,60}/i);
      expect(match?.[0] ?? null).toBeNull();
    },
  );
});
