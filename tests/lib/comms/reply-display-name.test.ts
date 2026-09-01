import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { replyAddressFor, tokenFromReplyAddress } from "@/lib/quote/chase";

/**
 * `replyAddressFor(token, displayName)` has a DEFAULT for its second argument,
 * and that default is the default brand's name. So omitting it does not fail,
 * does not warn, and does not show up in a type check — it silently puts one
 * company's name on another company's email.
 *
 * That is what happened in `lib/comms/review-request.ts`: a correct
 * brand-resolved `From:` alongside a `Reply-To:` whose display name named a
 * company the customer had never dealt with. `dispatchComm` passes `replyTo`
 * straight through and `send.ts` sets `reply_to` with no rewrite, so it reached
 * the wire. The review email's own copy invites a reply, so the leak surfaced
 * on exactly the action it asked for.
 *
 * Eleven other call sites already passed the name. One omission was enough, and
 * a test naming only that one line would not stop the twelfth. So this counts
 * EVERY call in the send paths and requires a second argument on all of them.
 *
 * The reply DOMAIN staying shared is deliberate and is NOT what this checks —
 * see `replyAddressFor`: the address is machine-facing, and a stub brand's
 * `reply_domain` has no MX, so a per-brand domain would be a dead Reply-To and
 * would break the panel thread.
 */

const ROOT = process.cwd();
const ROOTS = ["lib", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/** Where the function is declared — its own signature legitimately shows the
 *  defaulted parameter, so it is not a call site. */
const DECLARED_IN = "lib/quote/chase.ts";

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join("/");

/** Every `replyAddressFor(...)` invocation, as `file:line` → argument text. The
 *  arguments are simple identifiers and property accesses at every site, so a
 *  non-nesting match is sufficient and stays readable. */
function callSites(): { where: string; args: string }[] {
  const found: { where: string; args: string }[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root), [])) {
      const path = rel(file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (path === DECLARED_IN && /export function replyAddressFor/.test(line)) return;
        for (const m of line.matchAll(/\breplyAddressFor\(([^)]*)\)/g)) {
          found.push({ where: `${path}:${i + 1}`, args: m[1] });
        }
      });
    }
  }
  return found;
}

describe("every reply address carries its OWN brand's display name", () => {
  const sites = callSites();

  it("finds the call sites at all", () => {
    // A zero-length list would make the assertion below pass while checking
    // nothing — a renamed function or a moved directory must fail loudly rather
    // than print clean.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("no call relies on the defaulted display name", () => {
    const bare = sites.filter((s) => !s.args.includes(","));
    expect(
      bare.map((s) => s.where),
      "these calls take the default brand's display name, whatever brand is sending",
    ).toEqual([]);
  });

  it("the review request in particular passes the resolved brand's name", () => {
    // Named explicitly because this is the one that was wrong, and because it
    // is the send whose copy asks the customer to reply.
    const src = readFileSync(join(ROOT, "lib/comms/review-request.ts"), "utf8");
    expect(src).toContain("replyAddressFor(token, brand.name)");
  });
});

describe("the shared reply domain is intact", () => {
  it("a non-default display name still round-trips to its token", () => {
    // The display name is cosmetic to the relay; the inbound webhook parses the
    // local part. If a future change moved the domain per brand, this is where
    // the panel thread would silently break.
    const addr = replyAddressFor("tok123456789", "Another Brand Ltd");
    expect(addr.startsWith("Another Brand Ltd <q-tok123456789@")).toBe(true);
    expect(tokenFromReplyAddress(addr)).toBe("tok123456789");
  });
});
