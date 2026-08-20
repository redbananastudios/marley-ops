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
  /** A third crew job — P0 #7 COMPLETES its job, so it must own one that no
   *  read-only spec (journey/job-detail read crewJobCustomer) depends on. Keeps
   *  the crew completion specs order-independent. */
  crewJobThree: { name: "E2E Crew Job Three", quoteRef: "E2E-CREW-003" },
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
  /** A DRAFT quote — the office quote-builder wizard. A draft opens straight into
   *  the 7-step builder (status==="draft" → editing), so the wizard spec drives it
   *  via a stable seeded row instead of the create→navigate flow (that soft-nav is
   *  a separate, tracked router.push race — see the quote-builder spec header). */
  draftQuote: { name: "E2E Draft Quote", quoteRef: "E2E-DRAFT-001", total: 1200 },
  vehicle: { name: "E2E Luton", registration: "E2E 001" },
  /** A quoted lead used ONLY by the office mark-lost test — dedicated so marking
   *  it lost never consumes a lead another spec depends on. */
  markLost: { name: "E2E Mark Lost" },
  /** An OPEN storage let (unsigned) with a remote-signing token — the public
   *  /s/<token> storage-agreement page. Client name drives the greeting. */
  storageAgreement: { client: "E2E Storage Client", signToken: "e2e-storage-sign-token-0001", site: "E2E Storage Site", unitCode: "E2E-U1" },
  /** A cubic survey with a customer share token — the public /cv/<token> self-fill
   *  page. Anchored to its own lead so the greeting has a first name. */
  cubicSurvey: { name: "E2E Cubic Survey", shareToken: "e2e-cubic-share-token-0001" },
  /** A crew day-sheet token — the public /sheet/<token> page (the SMS'd day plan).
   *  Points at the e2e-crew staff row for TOMORROW (their seeded crew job's day). */
  daySheet: { token: "e2e-day-sheet-token-0001" },
  /** A SEPARATE staff member with a SUBMITTED invoice — the office contractor-pay
   *  review (return / mark paid). Separate from the crew login so the contractor
   *  sign-gate reset never wipes it. */
  payCrew: { name: "E2E Pay Crew", statementRef: "MMP-E2E01" },
  /** A lead with an OPEN claim — the claims working page (status/resolution). */
  claim: { name: "E2E Claim Lead" },
  /** A lead with a DUE follow-up — the follow-ups queue (snooze / done). */
  followUp: { name: "E2E Follow-up Lead" },
  /** The crew sign-up link — /join/<token>. Unlike the other public-page
   *  fixtures above (which seed a record for the page to READ), this one is
   *  purely the feature switched ON + a stable token: the spec itself POSTs a
   *  fresh application every run, using the shared E2E sink contact. `actions.ts`
   *  treats a repeat submission with the same email+phone as an UPDATE to the
   *  still-pending row (not a duplicate), so re-runs stay idempotent without a
   *  wipe step. Mirrors `self_billing_enabled` — a singleton settings toggle the
   *  seed turns on unconditionally. */
  joinApplicant: { token: "e2e-join-token-0001", name: "E2E Join Applicant" },
} as const;
