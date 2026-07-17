/**
 * Shared constants for the crew training-video demo dataset. Everything here is
 * FAKE and local-only: seed-demo.mjs writes it into the local Supabase, and
 * record.ts looks it up (and toggles the contract signature) while filming.
 */

export const DEMO_TAG = "TRAINING DEMO — safe to delete";

export const CREW_LOGIN = {
  email: "crew@marleymoves.test",
  password: "MarleyOps!2026", // local dev password only (scripts/seed-dev-crew.mjs)
  fullName: "Jack Reed (Dev)",
};

export const DEMO_CUSTOMER = {
  name: "Sarah Bennett",
  email: "sarah.bennett@example.com",
  phoneE164: "+447700900123", // Ofcom drama range — never a real number
  phoneRaw: "07700 900123",
  fromAddress: "14 Bimport, Shaftesbury",
  fromPostcode: "SP7 8AY",
  toAddress: "5 Queen Street, Gillingham",
  toPostcode: "SP8 4DZ",
};

export const DEMO_QUOTE_REF = "MMR900"; // clearly out of the local counter's path

export function localGuard(url) {
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  const ok = url.includes("127.0.0.1") || url.includes("localhost") || /\/\/i9(:|\/)/.test(url);
  if (!ok) throw new Error(`Refusing to touch a non-local Supabase URL: ${url}`);
}
