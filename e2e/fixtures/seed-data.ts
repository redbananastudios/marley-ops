/**
 * The known state the E2E suite runs against — the single source of truth shared
 * by scripts/seed-e2e.mjs (which writes it) and the specs (which assert it).
 * Keep the two in lockstep: change a name/ref here, reseed, and the tests follow.
 *
 * Everything is marked with E2E_MARKER so the seed can wipe ONLY its own rows and
 * re-create them (idempotent reset), never touching hand-made data.
 */

export const E2E_MARKER = "E2E-SEED";

/** All seeded customer contacts point at a sink you control (never a real
 *  inbox/number). Override via env when running against staging. */
export const E2E_SINK_EMAIL = process.env.E2E_SINK_EMAIL || "e2e@marleymoves.test";
export const E2E_SINK_PHONE = process.env.E2E_SINK_PHONE || "07700900000";

/** Test users the auth setup signs in as (must exist in the target's auth +
 *  be linked to staff where relevant). Passwords come from env — never commit. */
export const E2E_USERS = {
  office: {
    email: process.env.E2E_OFFICE_EMAIL || "e2e-office@marleymoves.test",
    password: process.env.E2E_OFFICE_PASSWORD || "",
    landing: /\/$|\/leads/,
  },
  estimator: {
    email: process.env.E2E_ESTIMATOR_EMAIL || "e2e-estimator@marleymoves.test",
    password: process.env.E2E_ESTIMATOR_PASSWORD || "",
    landing: /\/estimator/,
  },
  crew: {
    email: process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test",
    password: process.env.E2E_CREW_PASSWORD || "",
    landing: /\/my-jobs/,
  },
} as const;

/** Deterministic seeded records the specs look for by name/ref. */
export const SEED = {
  /** A customer with an accepted quote + a removal booked TOMORROW, crew
   *  (e2e-crew) assigned — drives the crew journey + the P0 completion scenarios. */
  crewJobCustomer: { name: "E2E Crew Job Customer", quoteRef: "E2E-CREW-001" },
  /** A second crew job (same crew, also tomorrow) — the double-submit scenario
   *  needs its own job because the completion one is consumed by P0 #7. */
  crewJobTwo: { name: "E2E Crew Job Two", quoteRef: "E2E-CREW-002" },
  /** A fresh website enquiry — office/estimator journey entry point. */
  freshEnquiry: { name: "E2E Fresh Enquiry" },
  /** An accepted quote awaiting a deposit — the deposit/card scenario. */
  awaitingDeposit: { name: "E2E Awaiting Deposit", quoteRef: "E2E-DEP-001" },
  /** A completed move with the balance outstanding — the balance-invoice scenario. */
  balanceDue: { name: "E2E Balance Due", quoteRef: "E2E-BAL-001" },
  /** A SENT quote with a fixed share token — the customer accept page /q/<token>.
   *  The token is a credential; a fixed local value lets the customer spec load it. */
  sentQuote: { name: "E2E Sent Quote", quoteRef: "E2E-SENT-001", acceptToken: "e2e-sent-accept-token-0001", total: 1500 },
  /** A second SENT quote used to test the DECLINE flow (so it never consumes the
   *  accept quote above). */
  declineQuote: { name: "E2E Decline Quote", quoteRef: "E2E-DECLINE-001", acceptToken: "e2e-decline-token-0001", total: 900 },
  vehicle: { name: "E2E Luton", registration: "E2E 001" },
} as const;
