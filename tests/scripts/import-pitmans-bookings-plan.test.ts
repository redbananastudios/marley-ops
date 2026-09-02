import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dry run is the thing a human approves before a live-money import, so it
 * has to describe what the WRITE path will actually do — and planning resolves
 * every row against the state as it was before the batch. One customer with two
 * forward bookings therefore missed the client lookup twice: the plan printed
 * NEW for both (two new customers where one is created) and skipped both
 * client-scoped VERIFY lines, while the write path re-resolves and attaches the
 * second booking to the client the first row created, keeping its terms.
 *
 * The importer talks to a live database from its first statement, so the
 * property is pinned by reading its source rather than running it — the same
 * reason seed-e2e's FK ordering is.
 */
const SRC = readFileSync(
  fileURLToPath(new URL("../../scripts/import-pitmans-bookings.mjs", import.meta.url)),
  "utf8",
);

describe("pitmans bookings dry-run plan", () => {
  it("keys planned clients with contactKey, not a hand-rolled fallback chain", () => {
    // A `email ?? phone` chain returns the EMPTY STRING for a contactless row,
    // so every such row would share one key and the plan would claim a dedupe
    // the write path never performs. contactKey returns null instead.
    expect(SRC).toContain("contactKey");
    expect(SRC).toContain("const plannedClients = new Map()");
  });

  it("resolves each row against what earlier rows of the same sheet create", () => {
    expect(SRC).toContain("const known = client ??");
    // Recorded AFTER the row has resolved, or every row would match itself.
    expect(SRC.indexOf("plannedClients.set(")).toBeGreaterThan(SRC.indexOf("const known = client ??"));
  });

  it("runs both client-scoped VERIFY checks against that resolved record", () => {
    // The two warnings that decide which payment ladder a customer gets. Gating
    // them on the pre-batch lookup alone is what made them silent for the very
    // rows they exist to catch.
    expect(SRC).not.toMatch(/if \(client && client\.is_company !== job\.isCompany\)/);
    expect(SRC).not.toMatch(/if \(client && job\.isCompany && job\.termsDays/);
    const block = SRC.match(/\n {2}if \(known\) \{([\s\S]*?)\n {2}\}\n/);
    expect(block, "no `if (known)` warning block").not.toBeNull();
    expect(block![1]).toContain("known.is_company !== job.isCompany");
    expect(block![1]).toContain("(known.payment_terms_days ?? 30) !== job.termsDays");
  });

  it("labels the row MATCH once an earlier row has claimed that customer", () => {
    expect(SRC).not.toContain('${client ? "MATCH" : "NEW  "}');
    expect(SRC).toContain('${known ? "MATCH" : "NEW  "}');
  });

  it("still hands the write path the STORED client only, so it re-resolves", () => {
    // A planned record has no id; the write path's own re-resolve against the
    // mutated clients list is what attaches the second booking.
    expect(SRC).toContain("plan.push({ job, client, kind, policy, depositSettled })");
    expect(SRC).toContain("let clientId = client?.id ?? findClient(job)?.id ?? null;");
  });
});
