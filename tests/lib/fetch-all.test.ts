import { describe, expect, it, vi } from "vitest";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

describe("fetchAllRows", () => {
  it("retrieves every window beyond PostgREST's 1,000-row cap", async () => {
    const rows = Array.from({ length: 2_005 }, (_, id) => ({ id }));
    const query = vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }));
    const result = await fetchAllRows(query);
    expect(result).toEqual(rows);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("fails soft with completed windows when a later window errors", async () => {
    const first = Array.from({ length: 1_000 }, (_, id) => ({ id }));
    const result = await fetchAllRows(async (from) =>
      from === 0 ? { data: first, error: null } : { data: null, error: { message: "timeout" } },
    );
    expect(result).toEqual(first);
  });

  it("fails closed for operational datasets when strict mode is enabled", async () => {
    await expect(fetchAllRows(
      async () => ({ data: null, error: { message: "timeout" } }),
      { strict: true },
    )).rejects.toThrow("Could not load complete dataset");
  });
});
