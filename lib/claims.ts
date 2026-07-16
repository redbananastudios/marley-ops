/**
 * Claims engine — PURE (no IO): status/resolution vocabulary, update
 * validation, and the small date maths the claims surfaces share. The claim
 * lifecycle a small removals firm actually runs: opened (auto from a sign-off
 * exception, or by hand when a customer calls) → assessed → an offer goes out →
 * settled or rejected; "closed" is the no-claim outcome (exception logged,
 * nothing pursued). Stage 2 spec agreed with Peter 2026-07-16.
 */

export const CLAIM_STATUSES = [
  "open",
  "assessing",
  "offer_made",
  "settled",
  "rejected",
  "closed",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Statuses that count as "live" — dashboard card, digest, default tab. */
export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = ["open", "assessing", "offer_made"];

export const isClaimStatus = (v: unknown): v is ClaimStatus =>
  typeof v === "string" && (CLAIM_STATUSES as readonly string[]).includes(v);

export const isOpenClaimStatus = (s: string): boolean =>
  (OPEN_CLAIM_STATUSES as readonly string[]).includes(s);

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  open: "Open",
  assessing: "Assessing",
  offer_made: "Offer made",
  settled: "Settled",
  rejected: "Rejected",
  closed: "Closed — no claim",
};

export const CLAIM_RESOLUTIONS = [
  "goodwill_payment",
  "insurer_claim",
  "repair",
  "no_claim",
  "rejected",
] as const;
export type ClaimResolution = (typeof CLAIM_RESOLUTIONS)[number];

export const isClaimResolution = (v: unknown): v is ClaimResolution =>
  typeof v === "string" && (CLAIM_RESOLUTIONS as readonly string[]).includes(v);

export const CLAIM_RESOLUTION_LABEL: Record<ClaimResolution, string> = {
  goodwill_payment: "Goodwill payment",
  insurer_claim: "Insurer claim",
  repair: "Repair / replacement",
  no_claim: "No claim pursued",
  rejected: "Claim rejected",
};

export const CLAIM_CHANNELS = ["sign_off", "phone", "email", "in_person", "other"] as const;
export type ClaimChannel = (typeof CLAIM_CHANNELS)[number];
/** Channels an office user can pick when opening a claim by hand — sign_off is
 *  reserved for the automatic open at completion. */
export const MANUAL_CLAIM_CHANNELS: readonly ClaimChannel[] = ["phone", "email", "in_person", "other"];

export const CLAIM_CHANNEL_LABEL: Record<ClaimChannel, string> = {
  sign_off: "Sign-off exception",
  phone: "Phone call",
  email: "Email",
  in_person: "In person",
  other: "Other",
};

/** "CLM-007" — short enough for an insurer email subject or a bank reference. */
export const claimRef = (claimNo: number): string => `CLM-${String(claimNo).padStart(3, "0")}`;

export interface ClaimUpdate {
  status: ClaimStatus;
  resolution: ClaimResolution | null;
  /** £; only meaningful with a resolution. */
  resolutionAmount: number | null;
}

/**
 * The single write-validation rule set (server action AND any future UI check
 * call this — the DB check constraint is the backstop):
 *  - a terminal status (settled/rejected/closed) must carry a resolution;
 *  - a goodwill payment must say how much left the business;
 *  - amounts must be sane (finite, ≥ 0, ≤ £1m);
 *  - reopening (moving back to a live status) clears resolution + amount.
 */
export function validateClaimUpdate(u: ClaimUpdate):
  | { ok: true; terminal: boolean; resolution: ClaimResolution | null; resolutionAmount: number | null }
  | { ok: false; error: string } {
  const terminal = !isOpenClaimStatus(u.status);
  if (!terminal) return { ok: true, terminal, resolution: null, resolutionAmount: null };

  if (!u.resolution) {
    return { ok: false, error: "Pick how the claim ended before closing it." };
  }
  const amount = u.resolutionAmount;
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000)) {
    return { ok: false, error: "The amount doesn't look right — enter pounds, no symbols." };
  }
  if (u.resolution === "goodwill_payment" && (amount == null || amount <= 0)) {
    return { ok: false, error: "A goodwill payment needs the amount paid out." };
  }
  return { ok: true, terminal, resolution: u.resolution, resolutionAmount: amount ?? null };
}

/** Whole days a claim has been open (UK-agnostic — day-scale, so UTC is fine). */
export function daysOpen(reportedAtIso: string, now: Date): number {
  const t = Date.parse(reportedAtIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * End of the customer's report window: 7 days after the completion sign-off
 * (generic T&Cs — legal review pending, so surfaces label it "T&Cs window").
 */
export function reportWindowEnd(completedAtIso: string): Date | null {
  const t = Date.parse(completedAtIso);
  return Number.isFinite(t) ? new Date(t + 7 * 86_400_000) : null;
}
