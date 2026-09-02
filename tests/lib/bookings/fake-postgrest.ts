import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A PostgREST client that can FAIL the way the real one fails.
 *
 * supabase-js does not reject on a database error — it RESOLVES with
 * `{ data: null, error }`. That is the whole reason the booking loader could
 * hand a caller an empty ledger for a read that never happened, and it is why a
 * test that makes the loader `mockRejectedValue` proves nothing: a rejection is
 * the one failure shape the real client cannot produce. Anything asserting
 * "a failed read is not an empty read" has to inject the error HERE.
 *
 * Every filter method returns the builder, so any chain the loader writes
 * (`.select().eq().is().not().order().range()`) lands on the canned result for
 * that table. Tables with no entry read as empty-and-fine, which keeps a test
 * naming only the read it is breaking.
 */

export interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

const CHAIN = [
  "select",
  "eq",
  "neq",
  "is",
  "not",
  "in",
  "gte",
  "lte",
  "gt",
  "lt",
  "order",
  "range",
  "limit",
  "maybeSingle",
  "single",
] as const;

export function fakePostgrest(tables: Record<string, FakeResult>): SupabaseClient {
  const builderFor = (res: FakeResult) => {
    const builder: Record<string, unknown> = {
      // Thenable, not a Promise: the loader awaits the builder directly, and a
      // resolved-with-error result is what we are here to reproduce.
      then: (resolve: (v: FakeResult) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(res).then(resolve, reject),
    };
    for (const method of CHAIN) builder[method] = () => builder;
    return builder;
  };
  return {
    from: (table: string) => builderFor(tables[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient;
}
