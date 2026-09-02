/**
 * Settings › Brands — the safe-display-field whitelist (multi-brand PRD §2
 * "Brand 3" row + §4 /settings).
 *
 * SERVER-SIDE ENFORCEMENT: `sanitizeBrandUpdate` builds the update object from
 * the hardcoded key list below — it NEVER spreads the client payload — so a
 * smuggled `slug`, `active`, `ref_prefix`, `name` (or anything else
 * structural) is stripped, not trusted. Why the split is what it is:
 *
 *   - A changed ref prefix breaks bank reconciliation on refs already issued:
 *     the quote ref IS the bank-transfer reference lib/bank-feed matches, so
 *     `ref_prefix` changes by migration only.
 *   - Activation is a runbook step, never a UI action: `active` IS the
 *     single-brand-invariant switch (PRD §1) — flipping it turns the entire
 *     brand UI on or off across the app, so it changes with eyes on it.
 *   - Names, legal lines, email identities and template ids feed comms and
 *     PDFs (gates 13/14 own their correctness); slug is a foreign key.
 *
 * Safe fields are presentation-only, per the PRD: phone, address, review URL,
 * terms URL, the two colours, logo URL, and the per-brand card-payments
 * switch.
 */

import { DEFAULT_BRAND } from "@/lib/brand";

/** The camelCase payload the Settings › Brands form submits. */
export type BrandUpdateInput = {
  phone?: string | null;
  address?: string | null;
  reviewUrl?: string | null;
  termsUrl?: string | null;
  colourPrimary?: string | null;
  colourAccent?: string | null;
  logoUrl?: string | null;
  cardPaymentsEnabled?: boolean;
};

/** The whitelisted `brands` update — snake_case column keys, nothing else.
 *  `card_payments_enabled` is absent for the DEFAULT brand (see
 *  sanitizeBrandUpdate): the column is never touched there. */
export type SafeBrandUpdate = {
  phone: string | null;
  address: string | null;
  review_url: string | null;
  terms_url: string | null;
  colour_primary: string | null;
  colour_accent: string | null;
  logo_url: string | null;
  card_payments_enabled?: boolean;
};

export type SanitizeBrandResult =
  | { ok: true; update: SafeBrandUpdate }
  | { ok: false; error: string };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type FieldResult = { ok: true; value: string | null } | { ok: false; error: string };

/** Optional text: trimmed, empty → null, wrong type / over-length rejected. */
function optText(v: unknown, label: string, max: number): FieldResult {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: `${label} must be text.` };
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `${label} is too long (max ${max} characters).` };
  return { ok: true, value: t };
}

/** Optional hex colour: #RRGGBB exactly, or empty to clear. */
function optHex(v: unknown, label: string): FieldResult {
  const r = optText(v, label, 7);
  if (!r.ok || r.value === null) return r;
  if (!HEX_RE.test(r.value)) {
    return { ok: false, error: `${label} must be a 6-digit hex colour like #C03838 (or empty to clear it).` };
  }
  return r;
}

/** Optional URL: https:// only (mirrors the Google-review-link rule), or empty to clear. */
function optHttpsUrl(v: unknown, label: string): FieldResult {
  const r = optText(v, label, 500);
  if (!r.ok || r.value === null) return r;
  if (!/^https:\/\//.test(r.value)) {
    return { ok: false, error: `${label} must be an https:// link (or empty to clear it).` };
  }
  return r;
}

/**
 * Validate + whitelist a Settings › Brands save. Pure — unit-tested in
 * tests/lib/brand-update.test.ts. Unknown keys (however structural they look)
 * come back stripped; bad hex / non-https URLs / wrong types reject loudly.
 * The card-payments switch must be an explicit boolean — a missing value could
 * only come from a broken client, and defaulting it either way would silently
 * flip a live payment channel.
 *
 * `slug` is the row this update is for. For the DEFAULT brand the per-brand
 * card flag is deliberately dead end-to-end (the QA-20260826-07 remainder:
 * cardPaymentsAvailable short-circuits `slug === DEFAULT_BRAND → true`,
 * cardEnabledBrands seeds the default unconditionally, emailTheme themes
 * Marley regardless) — so the field is IGNORED here, never validated and
 * never persisted: a stored value the runtime will never read is exactly the
 * false state the Settings toggle used to assert. Omitting `slug` keeps the
 * non-default behaviour (legacy callers/tests); the Settings action always
 * passes it, pinned by tests/lib/brand-update.test.ts.
 */
export function sanitizeBrandUpdate(input: Record<string, unknown>, slug?: string): SanitizeBrandResult {
  const phone = optText(input.phone, "Phone", 50);
  if (!phone.ok) return phone;
  const address = optText(input.address, "Address", 500);
  if (!address.ok) return address;
  const reviewUrl = optHttpsUrl(input.reviewUrl, "Review link");
  if (!reviewUrl.ok) return reviewUrl;
  const termsUrl = optHttpsUrl(input.termsUrl, "Terms link");
  if (!termsUrl.ok) return termsUrl;
  const colourPrimary = optHex(input.colourPrimary, "Primary colour");
  if (!colourPrimary.ok) return colourPrimary;
  const colourAccent = optHex(input.colourAccent, "Accent colour");
  if (!colourAccent.ok) return colourAccent;
  const logoUrl = optHttpsUrl(input.logoUrl, "Logo URL");
  if (!logoUrl.ok) return logoUrl;

  const update: SafeBrandUpdate = {
    phone: phone.value,
    address: address.value,
    review_url: reviewUrl.value,
    terms_url: termsUrl.value,
    colour_primary: colourPrimary.value,
    colour_accent: colourAccent.value,
    logo_url: logoUrl.value,
  };

  if (slug !== DEFAULT_BRAND) {
    if (typeof input.cardPaymentsEnabled !== "boolean") {
      return { ok: false, error: "Card payments must be explicitly on or off." };
    }
    update.card_payments_enabled = input.cardPaymentsEnabled;
  }
  // DEFAULT brand: the field never reaches the row — see the doc comment.

  return { ok: true, update };
}
