/**
 * Sandbox test cards for the card-payment scenarios. NEVER a real card — the
 * suite must only ever hit the takepayments SANDBOX (a live test payment creates
 * a real VAT tax point). The exact PANs come from the takepayments sandbox docs;
 * fill them in from the merchant sandbox console when wiring the card scenarios.
 */
export const SANDBOX_CARDS = {
  // Approved / successful authorisation.
  approved: { number: process.env.E2E_CARD_APPROVED || "", expiry: "12/30", cvv: "123", name: "E2E Approved" },
  // Declined at authorisation — drives the "card declined mid-booking" P0.
  declined: { number: process.env.E2E_CARD_DECLINED || "", expiry: "12/30", cvv: "123", name: "E2E Declined" },
} as const;

export const cardsConfigured = (): boolean => !!SANDBOX_CARDS.approved.number && !!SANDBOX_CARDS.declined.number;
