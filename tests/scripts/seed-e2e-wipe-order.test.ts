import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * QA-20260822-02: wipe() deleted `surveys` inside the LEAD_CHILD_TABLES loop —
 * i.e. BEFORE the appointments delete — but appointments.survey_id is a second,
 * deeper FK into surveys with NO ACTION (0001_init.sql). Any leftover
 * survey-type E2E appointment therefore killed the wipe on
 * `appointments_survey_id_fkey`, and because die() exits the process, the row
 * that broke the run was never cleared — so every subsequent CI run failed
 * identically. Staging CI's e2e job was red and self-perpetuating.
 *
 * The invariant is an ORDERING one, and wipe() runs against a live database, so
 * it is pinned by reading the script's own source rather than executing it.
 */
const SRC = readFileSync(
  fileURLToPath(new URL("../../scripts/seed-e2e.mjs", import.meta.url)),
  "utf8",
);

describe("seed-e2e wipe() FK ordering", () => {
  it("does not delete surveys in the lead_id child-table loop", () => {
    const block = SRC.match(/const LEAD_CHILD_TABLES = \[([\s\S]*?)\];/);
    expect(block, "LEAD_CHILD_TABLES literal not found").not.toBeNull();
    const tables = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    // surveys must NOT be here: it has to outlive the appointments that point at it.
    expect(tables).not.toContain("surveys");
  });

  it("deletes surveys only after the appointments that reference them", () => {
    const apptDelete = SRC.indexOf('from("appointments").delete().in("lead_id", leadIds)');
    const surveyDelete = SRC.indexOf('from("surveys").delete()');
    expect(apptDelete, "appointments delete not found").toBeGreaterThan(-1);
    expect(surveyDelete, "surveys delete not found").toBeGreaterThan(-1);
    expect(surveyDelete).toBeGreaterThan(apptDelete);
  });

  it("releases any remaining appointments.survey_id links before deleting surveys", () => {
    const release = SRC.indexOf('from("appointments").update({ survey_id: null })');
    const surveyDelete = SRC.indexOf('from("surveys").delete()');
    expect(release, "survey_id link release not found").toBeGreaterThan(-1);
    expect(release).toBeLessThan(surveyDelete);
  });
});
