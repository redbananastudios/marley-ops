/**
 * Shared, framework-agnostic helpers for the global command palette.
 *
 * No "use client"/"use server" directive: this module is imported by BOTH the
 * server action (app/actions/global-search.ts) and the client palette, so it
 * must stay pure (no React, no DOM, no server-only imports).
 */

/** A query must reach this many usable characters before we hit the database. */
export const MIN_SEARCH_LEN = 2;

/**
 * Strip the characters that would break the PostgREST `or()`/`ilike` filter
 * grammar: commas + parens delimit conditions, `%`/`*` are wildcards, and
 * backslash/quote escape. Mirrors the sanitiser in
 * app/(dashboard)/quotes/page.tsx — refs, names and postcodes never
 * legitimately contain any of these.
 */
export function sanitiseSearchTerm(q: string): string {
  return (q ?? "").replace(/[,()%*\\"]/g, "").trim();
}

export interface LeadHit {
  id: string;
  name: string | null;
  status: string;
  fromPostcode: string | null;
  toPostcode: string | null;
}

export interface ClientHit {
  id: string;
  name: string | null;
  /** email, else phone — whichever we have (for the muted subtitle). */
  subtitle: string | null;
}

export interface QuoteHit {
  id: string;
  ref: string | null;
  name: string | null;
  status: string;
}

export interface GlobalSearchResults {
  leads: LeadHit[];
  clients: ClientHit[];
  quotes: QuoteHit[];
}

export const EMPTY_RESULTS: GlobalSearchResults = { leads: [], clients: [], quotes: [] };
