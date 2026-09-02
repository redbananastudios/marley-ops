import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The `--brand <slug>` run of scripts/create-resend-templates.mjs (multi-brand
 * PRD §3.5, §11.7 trap 4) — the operator procedure that stands up a second
 * brand's hosted templates and hands back the ids to store on its brands row.
 *
 * Two classes of defect live here and neither surfaces at wire time, because
 * both fail SILENTLY into the in-repo fallback or into a missing sentence:
 *
 *  - the ids are printed under one key convention and read under another, so
 *    every send resolves undefined and degrades to inline HTML forever;
 *  - a template drops a §3.5 disclosure its sibling carries, so which
 *    disclosure a customer receives depends on which render path fired.
 *
 * The id capture only happens against the live API, so that half is asserted
 * from the source. The HTML half runs the script's own `--preview-dir` mode,
 * which renders to disk with no API key and no network.
 */

const SCRIPT = join(process.cwd(), "scripts", "create-resend-templates.mjs");
const source = readFileSync(SCRIPT, "utf8");

/* ------------------------------------------------------------ id capture */

describe("a brand run records ids under the key the app resolves", () => {
  it("keys the printed map by the env-var name, never by the hosted template name", () => {
    // templateIdFor(brand, envName) reads brands.resend_template_ids[envName],
    // and every call site passes an env-var name. Recording under anything else
    // produces a map that resolves nothing, with no error anywhere.
    const captured = source.match(/idsByKey\[(\w+)\]\s*=\s*id;/);
    expect(captured, "the id-capture line moved or was renamed").not.toBeNull();
    expect(captured![1]).toBe("envVar");
  });

  it("carries an envVar on every registry entry, so no id is recorded under undefined", () => {
    const named = [...source.matchAll(/\n {4}name: "([a-z0-9-]+)",\n/g)].map((m) => m[1]);
    const paired = [...source.matchAll(/\n {4}name: "([a-z0-9-]+)",\n {4}envVar: "([A-Z0-9_]+)",\n/g)];
    expect(named.length).toBeGreaterThan(15); // the parser still finds the registry
    expect(paired.map((m) => m[1])).toEqual(named);
  });

  it("keeps a pair the name could never be mechanically converted into", () => {
    // The reason the map is keyed by envVar rather than derived from the name:
    // these two pairs have no shared derivation, so a name-keyed map would need
    // a hand-maintained conversion table that drifts.
    const paired = new Map(
      [...source.matchAll(/\n {4}name: "([a-z0-9-]+)",\n {4}envVar: "([A-Z0-9_]+)",\n/g)].map((m) => [m[1], m[2]]),
    );
    expect(paired.get("completion-certificate")).toBe("RESEND_TEMPLATE_COMPLETION_CERT");
    expect(paired.get("crew-portal-invite")).toBe("RESEND_TEMPLATE_CREW_INVITE");
  });

  it("documents the same key convention as the resolver it feeds", () => {
    // The two header comments contradicting each other is how the convention
    // drifted in the first place: an operator follows the script's paste
    // instruction, not the resolver's doc comment.
    const resolver = readFileSync(join(process.cwd(), "lib", "comms", "template-id.ts"), "utf8");
    const example = "RESEND_TEMPLATE_QUOTE_EMAIL";
    expect(resolver).toContain(example);
    const header = source.slice(0, source.indexOf("import "));
    expect(header, "the header must show the operator the key they will paste").toContain(example);
  });
});

/* --------------------------------------------------------- rendered HTML */

/** Render one brand's whole set to a temp directory. No key, no network. */
function renderPreview(brand: string): (name: string) => string {
  const directory = mkdtempSync(join(tmpdir(), `resend-preview-${brand}-`));
  rendered.push(directory);
  execFileSync(process.execPath, [SCRIPT, "--brand", brand, "--preview-dir", directory], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  return (name: string) => readFileSync(join(directory, `${name}.html`), "utf8");
}

const rendered: string[] = [];
afterAll(() => {
  for (const directory of rendered) rmSync(directory, { recursive: true, force: true });
});

describe("the pre-move disclosure is on every pre-move template", () => {
  const secondBrand = renderPreview("pitmans");
  const defaultBrand = renderPreview("marley");

  /** The identifying fragment of §3.5 disclosure (b), free of brand literals. */
  const DISCLOSURE = /vehicle or crew/i;

  it("renders it on the date-change confirmation (so the check is calibrated)", () => {
    expect(secondBrand("pitmans-date-change-confirmation")).toMatch(DISCLOSURE);
  });

  it("renders it on the cancellation ack, which is the same rebook, inside the window", () => {
    // booking-change sends the date-change confirmation outside the 7-day
    // window and this one inside it. Both roll the booking to a new date, so
    // both are pre-move comms; carrying the disclosure on only one means which
    // one a customer receives decides whether they are told at all.
    expect(secondBrand("pitmans-cancellation-ack")).toMatch(DISCLOSURE);
  });

  it("renders it on neither for the default brand, whose set is unchanged", () => {
    expect(defaultBrand("cancellation-ack")).not.toMatch(DISCLOSURE);
    expect(defaultBrand("date-change-confirmation")).not.toMatch(DISCLOSURE);
  });
});
