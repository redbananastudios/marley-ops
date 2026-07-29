/**
 * Escape SQL LIKE/ILIKE wildcards so a value matches LITERALLY (still
 * case-insensitively under `.ilike`). Postgres LIKE treats `%` and `_` as
 * wildcards and `\` as the escape char, so an un-escaped identifier such as an
 * email containing `_` matches unintended rows — `.ilike("email", "a_b@x.com")`
 * also matches `axb@x.com`. On an RLS-bypassing service-role client that can
 * resolve the WRONG record, so every by-identifier lookup that uses `.ilike`
 * purely for case-insensitivity must escape its value first.
 */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
