import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Sanity pull rail's INCREMENTAL CUTOFF (lib/sync/sanity-leads.ts).
 *
 * This rail is one brand's website only, and it is the backstop that recovers
 * an enquiry whose direct push failed. The cutoff is derived from our own
 * leads table, so anything that can advance it past an un-landed document
 * silently blinds the backstop for a whole day — the loss is invisible by
 * construction, which is the entire reason a second rail exists.
 *
 * `source_system = 'website'` used to be a marker for this rail alone. It is
 * not any more: every brand's ingest lands through the same shared lander and
 * stamps the same value, so the cutoff has to be scoped by brand or the other
 * brand's traffic moves this brand's window.
 */

const groqQueries: string[] = [];
/** Every `.eq()` the cutoff read applied, in order — the discriminating fact. */
let cutoffFilters: [string, unknown][] = [];

/** Rows the fake leads table holds, newest LAST so ordering has work to do. */
const LEAD_ROWS = [
  { brand: "marley", source_system: "website", submitted_at: "2026-12-10T09:00:00.000Z" },
  { brand: "pitmans", source_system: "website", submitted_at: "2026-12-23T09:00:00.000Z" },
];

/**
 * The narrowest possible PostgREST stand-in: it records the filters the cutoff
 * read applies and answers from LEAD_ROWS through those same filters, so a
 * query that forgets a filter genuinely sees the other brand's row rather than
 * being told off by an assertion on the builder.
 */
function fakeAdmin() {
  return {
    from: () => {
      const filters: [string, unknown][] = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.not = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      };
      builder.maybeSingle = async () => {
        cutoffFilters = filters;
        const matching = LEAD_ROWS.filter((row) =>
          filters.every(([col, val]) => (row as Record<string, unknown>)[col] === val),
        ).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
        return { data: matching[0] ?? null, error: null };
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin(),
}));

import { syncSanityLeads } from "@/lib/sync/sanity-leads";

beforeEach(() => {
  groqQueries.length = 0;
  cutoffFilters = [];
  vi.stubEnv("SANITY_SYNC_DISABLED", "");
  vi.stubEnv("SANITY_API_READ_TOKEN", "test-token");
  vi.stubEnv("LEAD_SYNC_SINCE", "2026-07-30T00:00:00Z");
  vi.stubGlobal(
    "fetch",
    (async (url: string) => {
      groqQueries.push(decodeURIComponent(new URL(String(url)).searchParams.get("query") ?? ""));
      return { ok: true, status: 200, json: async () => ({ result: [] }), text: async () => "" };
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("syncSanityLeads — the incremental cutoff is scoped to this rail's brand", () => {
  it("another brand's newer enquiry cannot advance this rail's window", async () => {
    // The failure this pins: this brand's newest landed enquiry is 10 Dec and a
    // document from 9 Dec never landed (its push 500'd mid-deploy). The other
    // brand's WordPress site kept producing enquiries, newest 23 Dec. Reading
    // the newest 'website' row of ANY brand puts the window at 21 Dec, so the
    // 9 Dec document is excluded from the GROQ filter and the only rail that
    // could recover it never asks for it.
    const result = await syncSanityLeads({ incremental: true });

    expect(result.ok).toBe(true);
    expect(groqQueries).toHaveLength(1);
    // 10 Dec minus the 2-day overlap — NOT 21 Dec (23 Dec minus the overlap).
    expect(groqQueries[0]).toContain('submittedAt >= "2026-12-08T09:00:00.000Z"');
    expect(groqQueries[0]).not.toContain("2026-12-21");
    expect(cutoffFilters).toContainEqual(["brand", "marley"]);
  });

  it("the go-live floor still wins when it is later than the cutoff", async () => {
    // The no-backfill floor is a hard lower bound and must stay one: narrowing
    // the cutoff read must not open a path that imports pre-cutover history.
    vi.stubEnv("LEAD_SYNC_SINCE", "2027-01-05T00:00:00Z");
    await syncSanityLeads({ incremental: true });
    expect(groqQueries[0]).toContain('submittedAt >= "2027-01-05T00:00:00Z"');
  });

  it("an unresolvable floor with no cutoff still REFUSES rather than importing unfloored", async () => {
    // Fail-closed: a full run with a garbled LEAD_SYNC_SINCE would otherwise
    // re-import every pre-go-live submission.
    vi.stubEnv("LEAD_SYNC_SINCE", "not-a-timestamp");
    const result = await syncSanityLeads({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("LEAD_SYNC_SINCE");
    expect(groqQueries).toHaveLength(0);
  });
});
