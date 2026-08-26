import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

// QA-20260826-02: the removals diary shipped gate 11's brand picker but never
// offered the bare-client options that make it reachable — only surveys did.
// Both diaries must offer bare clients the same way, or `requireBrand` in
// AppointmentDialog (driven by `isClient`) is dead code on one of them.
describe("diary bare-client parity (gate 11)", () => {
  const pages = {
    surveys: read("app/(dashboard)/schedule/surveys/page.tsx"),
    removals: read("app/(dashboard)/schedule/removals/page.tsx"),
  };

  it.each(Object.entries(pages))("%s diary offers bare clients in the booking combobox", (_name, source) => {
    // Queries clients (excluding merged/inactive) and marks them bookable…
    expect(source).toContain('.from("clients")');
    expect(source).toContain('.is("merged_into_id", null)');
    expect(source).toContain('.eq("is_active", true)');
    expect(source).toContain("isClient: true");
    // …only those with no lead yet (client_id must be in the leads select for this)…
    expect(source).toContain("clientIdsWithLeads");
    expect(source).toContain('"id,client_id,');
    // …and actually hands them to the dialog alongside the leads.
    expect(source).toContain("leads={[...leadOptions, ...clientOptions]}");
  });
});
