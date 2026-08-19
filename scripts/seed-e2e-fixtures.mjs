/**
 * Seed fixture shapes shared between scripts/seed-e2e.mjs and the vitest
 * contract test (tests/scripts/seed-e2e-cubic-items.test.ts).
 *
 * The cubic-survey items MUST be spec-correct CubicLine objects
 * (lib/cubic-survey.ts): the customer submit path re-validates the STORED row
 * via sanitizeCubicLines(), so a malformed seed makes /cv/<token> permanently
 * unsubmittable with only the generic "needs attention" message
 * (QA-20260819-02). The test imports this literal so the shape can never
 * silently drift from CubicLine again.
 */

// Mirrors lib/cubic-catalogue.ts "living-space:sofa-2-seater" (35 ft³).
// Fixed UUID so a re-seed always lands the identical row.
export const CUBIC_SURVEY_SEED_ITEMS = [
  {
    id: "e2ec0b1c-5eed-4001-8001-000000000001",
    key: "living-space:sofa-2-seater",
    title: "Sofa 2 seater",
    category: "living-space",
    qty: 1,
    unitFt3: 35,
  },
];
