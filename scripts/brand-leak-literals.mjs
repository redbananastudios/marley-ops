/**
 * Brand-leak scan — THE ONE LIST, and the detector that reads it.
 *
 * Extracted from scripts/brand-leak-scan.mjs on 2026-09-02 when the RENDERED
 * half of PRD §6.4 landed (e2e/public/brand-leak-rendered.spec.ts). The reason
 * is mechanical, not stylistic, and worth stating so nobody folds it back in:
 *
 *   Playwright transpiles spec files (and everything they import) to CommonJS.
 *   `brand-leak-scan.mjs` uses `import.meta.url` twice — to resolve the repo
 *   ROOT and to detect direct invocation — and `import.meta` cannot survive that
 *   transform: importing it from a spec fails at load with "Cannot use
 *   'import.meta' outside a module". The scan script cannot give those two lines
 *   up (cwd is not the repo root from every runner), so the parts BOTH halves
 *   need moved here instead, into a module with no filesystem awareness at all.
 *
 * The alternative was a second copy of the literal list inside the e2e spec.
 * Two lists that must agree WILL drift, and the drift would be silent in the
 * worst possible direction: a literal added here and missed there would read as
 * "the rendered pages are clean" while nothing had ever looked for it. One
 * list, imported by the source grep, its vitest twin, and the Playwright
 * assertion alike.
 *
 * Like the scan script, this file necessarily CONTAINS every forbidden literal,
 * so it must never be added to the scan's MANIFEST.
 */

/**
 * Forbidden literals per PRD §6.4, both directions. `ci: true` matches
 * case-insensitively (domains, phones, tokens, mailboxes); name literals stay
 * case-SENSITIVE on purpose — the lowercase brand slugs (`marley`,
 * `pitmans`) are data keys (DEFAULT_BRAND, `?brand=` values, data-brand
 * attributes) and are legal everywhere.
 */
export const FORBIDDEN = [
  // Default-brand literals that must not reach a second-brand-capable surface.
  { literal: "Marley", brand: "marley", ci: false },
  { literal: "marleymoves.co.uk", brand: "marley", ci: true },
  { literal: "01747 637070", brand: "marley", ci: true },
  { literal: "01747637070", brand: "marley", ci: true },
  { literal: "Connor", brand: "marley", ci: false },
  { literal: "connor@", brand: "marley", ci: true }, // the mailbox form a case-sensitive "Connor" misses
  { literal: "mm-red", brand: "marley", ci: true }, // the brand-colour Tailwind token — colour comes from brands.colour_primary
  // Reverse direction: second-brand literals must not be hardcoded either.
  { literal: "Pitmans", brand: "pitmans", ci: false },
  { literal: "pitmansremovals.co.uk", brand: "pitmans", ci: true },
  { literal: "01258 858564", brand: "pitmans", ci: true },
  { literal: "01258858564", brand: "pitmans", ci: true },
];

/**
 * The core detector: every forbidden-literal hit in one file's content, with
 * 1-based line numbers. Exported so the vitest twin can prove the detector
 * detects (a zero-findings run is evidence only if the detector demonstrably
 * fires on seeded content) — and so the rendered half matches with the SAME
 * case-sensitivity rules rather than a second implementation of them.
 */
export function findLeaksInContent(content, file = "<content>") {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const { literal, brand, ci } of FORBIDDEN) {
      const haystack = ci ? line.toLowerCase() : line;
      const needle = ci ? literal.toLowerCase() : literal;
      if (haystack.includes(needle)) {
        findings.push({ file, line: i + 1, literal, brand });
      }
    }
  }
  return findings;
}
