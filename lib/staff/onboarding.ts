import { z } from "zod";

/**
 * Public staff onboarding — pure helpers shared by the /join/<token> page,
 * the office review actions and the tests. NO node imports here (the review
 * UI is a client component); the timing-safe token compare lives in
 * lib/staff/onboard-token.ts (server only).
 */

/** Full years between a YYYY-MM-DD date of birth and `today`. null = not a real date. */
export function ageFromDob(dob: string, today: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Reject rollovers (31 Feb parses as 2-3 Mar).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/** Loose UK phone check — digits with spaces/dashes/brackets, 0… or +44… shape. */
export function isUkPhone(raw: string): boolean {
  const digits = raw.replace(/[\s()\-.]/g, "");
  return /^(?:\+44\d{9,10}|0\d{9,10})$/.test(digits);
}

/** Canonical form for phone COMPARISON (not storage): strip everything but
 *  digits, fold +44/44 onto the leading-0 form — "07572 382-366", "+44 7572
 *  382366" and "447572382366" all compare equal. Empty input stays "". */
export function normalisePhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("44") && digits.length > 10 ? `0${digits.slice(2)}` : digits;
}

const MIN_AGE = 16;
const MAX_AGE = 80;

/** Lenient standard-form UK postcode (outward + inward, optional space). */
const UK_POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/;

/** Bounded free-text — same trim + slice discipline as the quote accept flow. */
const bounded = (max: number) => z.string().trim().transform((s) => s.slice(0, max));

export const staffSubmissionSchema = z.object({
  full_name: z.string().trim().min(1, "Enter your full name").transform((s) => s.slice(0, 120)),
  date_of_birth: z
    .string()
    .trim()
    .min(1, "Enter your date of birth")
    .refine((s) => ageFromDob(s) !== null, "Enter a valid date of birth")
    .refine(
      (s) => {
        const age = ageFromDob(s);
        return age === null || (age >= MIN_AGE && age <= MAX_AGE);
      },
      `You need to be between ${MIN_AGE} and ${MAX_AGE} to join the crew`,
    ),
  address_line1: z.string().trim().min(1, "Enter your street address").transform((s) => s.slice(0, 160)),
  address_town: bounded(80).optional(),
  address_postcode: z
    .string()
    .trim()
    .min(1, "Enter your postcode")
    .refine((s) => UK_POSTCODE_RE.test(s), "Enter a valid UK postcode")
    .transform((s) => s.toUpperCase().slice(0, 10)),
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address")
    .email("Enter a valid email address")
    .transform((s) => s.slice(0, 254).toLowerCase()),
  phone: z
    .string()
    .trim()
    .min(1, "Enter your mobile number")
    .refine(isUkPhone, "Enter a valid UK phone number")
    .transform((s) => s.slice(0, 30)),
  is_driver: z.boolean(),
  emergency_contact_name: bounded(120).optional(),
  emergency_contact_phone: bounded(120).optional(),
  notes: bounded(1000).optional(),
});

export type StaffSubmissionInput = z.input<typeof staffSubmissionSchema>;
export type StaffSubmissionParsed = z.output<typeof staffSubmissionSchema>;

/** One-line display address from the structured parts (line1, town, postcode) —
 *  what goes in the legacy `address` column, the review queue and the staff copy. */
export function formatSubmissionAddress(v: {
  address_line1: string;
  address_town?: string | null;
  address_postcode: string;
}): string {
  return [v.address_line1, v.address_town ?? "", v.address_postcode]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}

/** Shape of a staff_submissions row the approve mapping needs. */
export interface SubmissionLike {
  full_name: string;
  date_of_birth: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  is_driver: boolean;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

/** The staff-row fields an approval writes — shared by update (matched active
 *  staff) and insert (brand-new crew record). Empty strings become null so a
 *  half-filled submission never stores "". */
export function staffFieldsFromSubmission(sub: SubmissionLike): {
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  date_of_birth: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  is_driver: boolean;
} {
  return {
    full_name: sub.full_name,
    phone: sub.phone || null,
    email: sub.email || null,
    address: sub.address || null,
    date_of_birth: sub.date_of_birth || null,
    emergency_contact_name: sub.emergency_contact_name || null,
    emergency_contact_phone: sub.emergency_contact_phone || null,
    is_driver: sub.is_driver,
  };
}
