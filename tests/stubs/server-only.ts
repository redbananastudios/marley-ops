/**
 * `server-only` has no npm package here — Next resolves it at build time, where
 * importing it from a client component is a hard error. That guarantee is a
 * BUILD concern and is unaffected by this file.
 *
 * Under vitest the specifier simply does not resolve, so every test file that
 * transitively reached a server module had to carry its own
 * `vi.mock("server-only", () => ({}))`. That worked while the modules were
 * imported directly, and broke the moment `lib/ledger/index.ts` began importing
 * the Xero adapter: five test files that had never heard of `server-only`
 * started failing at import, because the seam they import now reaches server
 * code three hops away.
 *
 * Aliasing it once in `vitest.config.ts` makes the per-file mocks unnecessary
 * and means a new server module can be added behind the seam without breaking
 * unrelated tests.
 */
export {};
