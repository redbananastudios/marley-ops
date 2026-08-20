import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { ENQUIRY_FRESH_WINDOW_MS } from "@/lib/push/categories";

/**
 * The website's direct lead post — the pure half.
 *
 * Everything here decides something without touching the network: is the caller
 * who it claims to be, is the payload usable, and is this timestamp plausibly a
 * LIVE enquiry. Pure so each rule can be proven in a test rather than inferred
 * from a route that also writes to a database, and so the route reads as a
 * sequence of decisions with one honest status code each.
 *
 * Why this endpoint exists at all: the only route a website enquiry had was a
 * `quoteSubmission` document written into a public Sanity dataset, which put
 * the customer's name, email, phone and both postcodes somewhere anyone could
 * read, and left the lead up to ~3h from the panel. A direct post retires both
 * problems at source.
 */

/** Below this length a configured secret is a placeholder, not a credential. */
export const MIN_INGEST_SECRET_LENGTH = 16;

/** One enquiry is a few hundred bytes. Anything near this is not a lead. */
export const MAX_INGEST_BODY_BYTES = 64 * 1024;

/**
 * How old a submission may be and still be accepted.
 *
 * Deliberately the SAME constant the push/alarm freshness rule uses, which
 * gives the endpoint a property worth having: anything it accepts is, by
 * construction, inside the freshness window, so an accepted lead ALWAYS raises
 * the office alert. It is also the guard against this route ever becoming a
 * back door for historical data — a submission cannot be backdated through it,
 * whatever the caller claims.
 */
export const MAX_SUBMISSION_AGE_MS = ENQUIRY_FRESH_WINDOW_MS;

/**
 * Is this caller authorised?
 *
 * FAILS CLOSED. A missing, blank or placeholder-short `LEAD_INGEST_SECRET` must
 * reject EVERY request. The alternative — reading "no secret configured" as "no
 * authentication required" — turns one unset environment variable into an open
 * lead-injection endpoint, and nothing in the response would say so.
 */
export function ingestAuthorized(
  authorizationHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  const configured = (secret ?? "").trim();
  if (configured.length < MIN_INGEST_SECRET_LENGTH) return false;

  const presented = (authorizationHeader ?? "").trim();
  const prefix = "Bearer ";
  if (!presented.startsWith(prefix)) return false;

  const token = Buffer.from(presented.slice(prefix.length));
  const expected = Buffer.from(configured);
  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  // That leaks the length of a wrong guess and nothing else.
  return token.length === expected.length && timingSafeEqual(token, expected);
}

/** Trimmed, length-capped, and empty-to-null so "" never reaches a column. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `must be ${max} characters or fewer`)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null));
}

/** Marketing attribution. Unknown keys are STRIPPED rather than refused: the
 *  site will grow new click ids, and a lead must never be lost over one. */
const attributionSchema = z.object({
  campaign: optionalText(200),
  variantKey: optionalText(200),
  landingUrl: optionalText(2000),
  landingReferrer: optionalText(2000),
  utmSource: optionalText(200),
  utmMedium: optionalText(200),
  utmCampaign: optionalText(200),
  utmContent: optionalText(200),
  utmTerm: optionalText(200),
  utmId: optionalText(200),
  gclid: optionalText(500),
  gbraid: optionalText(500),
  wbraid: optionalText(500),
  fbclid: optionalText(500),
  msclkid: optionalText(500),
  ttclid: optionalText(500),
  liFatId: optionalText(500),
  posthogDistinctId: optionalText(200),
});

/**
 * One enquiry per request. An object, never an array — there is deliberately no
 * shape in which this route can take a batch, so it cannot become an import
 * tool by a later edit that only looks like a convenience.
 *
 * Content is validated LENIENTLY where a customer typed it (a mistyped email is
 * a typo, not a malformed request, and losing a lead with a good phone number
 * over it would be the worse failure — the bounce handler is the real guard).
 * Shape, type and length are validated strictly.
 */
export const websiteLeadIngestSchema = z.object({
  /** The site's own submission id. Stable across its retries — this is what
   *  makes three deliveries produce one lead. */
  leadId: z
    .string()
    .trim()
    .min(8, "must be at least 8 characters")
    .max(200, "must be 200 characters or fewer")
    .regex(/^[A-Za-z0-9._:-]+$/, "must be an opaque id (letters, digits, . _ : -)"),
  name: z.string().trim().min(1, "is required").max(200, "must be 200 characters or fewer"),
  phone: optionalText(50),
  email: optionalText(320),
  fromPostcode: optionalText(20),
  toPostcode: optionalText(20),
  propertySize: optionalText(120),
  preferredDate: optionalText(120),
  services: z
    .array(z.string().trim().max(120))
    .max(30, "must be 30 entries or fewer")
    .optional()
    .nullable()
    .transform((v) => v ?? []),
  notes: optionalText(5000),
  /** Which form produced it ("homepage_hero_2step"), not the marketing source. */
  source: optionalText(200),
  /** The customer's own "How did you hear about us?" answer. */
  referrer: optionalText(200),
  submittedAt: optionalText(64),
  attribution: attributionSchema.optional().nullable(),
})
  // A lead we cannot ring or email is not a lead. Refusing is the kinder
  // outcome: the caller's fallback puts it in front of a human, where a row
  // with no way to contact the customer would just sit in the panel.
  .refine((v) => Boolean(v.phone) || Boolean(v.email), {
    message: "provide a phone or an email",
  });

export type WebsiteLeadIngestInput = z.infer<typeof websiteLeadIngestSchema>;

export type SubmittedAtResolution =
  | { ok: true; submittedAt: string }
  | { ok: false; reason: string };

/**
 * Resolve the submission time, refusing anything that would backdate a lead.
 *
 * The two directions are treated differently on purpose. A timestamp in the
 * PAST beyond the window is the historical-import shape and is refused outright.
 * A timestamp in the FUTURE is a caller whose clock runs fast — it cannot
 * smuggle history in, so it is clamped to arrival time rather than costing us a
 * real enquiry over a few seconds of skew.
 */
export function resolveSubmittedAt(raw: string | null | undefined, now: Date): SubmittedAtResolution {
  if (!raw) return { ok: true, submittedAt: now.toISOString() };
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return { ok: false, reason: "submittedAt is not a valid timestamp" };
  if (now.getTime() - t > MAX_SUBMISSION_AGE_MS) {
    return {
      ok: false,
      reason: "submittedAt is more than 24 hours old — this endpoint takes live enquiries only",
    };
  }
  if (t > now.getTime()) return { ok: true, submittedAt: now.toISOString() };
  return { ok: true, submittedAt: new Date(t).toISOString() };
}

/** First validation failure as one line the caller can put in its own log. */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid payload";
  const path = issue.path.join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
