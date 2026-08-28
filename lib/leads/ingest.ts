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

/** One configured ingest secret and the brand it authorises. */
export interface BrandIngestSecret {
  brand: string;
  secret: string | null | undefined;
}

/**
 * Every ingest secret the environment configures, each naming its brand.
 *
 * `LEAD_INGEST_SECRET` is Marley's and predates the brand layer — the live
 * marleymoves.co.uk site posts with it, so its name and its behaviour never
 * change. Every other brand gets `LEAD_INGEST_SECRET_<SLUG-UPPERCASED>`
 * (`LEAD_INGEST_SECRET_PITMANS` → brand `pitmans`): the suffix lowercased IS
 * the brand slug, so wiring a new site is an environment variable, not a code
 * change. A suffix that names no row in `brands` cannot land a lead — the
 * insert's foreign key refuses it, loudly, as a 5xx the caller retries and
 * escalates to a human, never as a lead filed under a brand that doesn't exist.
 */
export function brandIngestSecrets(
  env: Record<string, string | undefined> = process.env,
): BrandIngestSecret[] {
  return withoutSharedSecrets(configuredIngestSecrets(env));
}

/** The raw configured set, before ambiguity is removed. */
function configuredIngestSecrets(env: Record<string, string | undefined>): BrandIngestSecret[] {
  const secrets: BrandIngestSecret[] = [{ brand: "marley", secret: env.LEAD_INGEST_SECRET }];
  const prefix = "LEAD_INGEST_SECRET_";
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix)) continue;
    const slug = key.slice(prefix.length).toLowerCase();
    if (slug) secrets.push({ brand: slug, secret: env[key] });
  }
  return secrets;
}

/**
 * Drop EVERY entry whose secret value is shared with another brand's.
 *
 * A duplicate is not a tie to break, it is a question with no answer. Two
 * brands presenting the same token are indistinguishable, so first-match-wins
 * does not resolve the ambiguity, it hides it — and the first candidate is
 * always the default brand, so the quiet outcome is the OTHER brand's customer
 * filed under the default one, carrying its quote-ref prefix, its legal line
 * and its sending address on a document that reaches a real person. Nothing
 * errors, so nothing says so.
 *
 * Refusing costs the shared token every brand that presents it, the default one
 * included. That is the intended trade: a 401 fires the caller's own documented
 * fallback (email the office) and the enquiry still reaches a human, whereas a
 * misfiled lead reaches the wrong customer under the wrong company's name.
 * Ambiguity yields nothing, never a best guess.
 *
 * Values below MIN_INGEST_SECRET_LENGTH are ignored: they authenticate nothing
 * already, and counting them would let two blank placeholders collide and
 * disable a brand that was never configured in the first place.
 */
function withoutSharedSecrets(secrets: readonly BrandIngestSecret[]): BrandIngestSecret[] {
  const seen = new Map<string, number>();
  for (const { secret } of secrets) {
    const value = (secret ?? "").trim();
    if (value.length < MIN_INGEST_SECRET_LENGTH) continue;
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  return secrets.map((entry) =>
    (seen.get((entry.secret ?? "").trim()) ?? 0) > 1 ? { brand: entry.brand, secret: null } : entry,
  );
}

/**
 * Configured ingest secrets that have been REFUSED for being shared, and which
 * brands they belong to. Pure, so the route can log it and a health surface can
 * raise it as a standing issue.
 *
 * Failing closed without saying so would only move the silence: an operator who
 * pasted one secret into two variables would see 401s and conclude the secret
 * was wrong, not that it was duplicated.
 */
export function sharedIngestSecretBrands(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = configuredIngestSecrets(env);
  const usable = withoutSharedSecrets(raw);
  return raw.filter((entry, i) => entry.secret && !usable[i].secret).map((e) => e.brand);
}

/**
 * Which brand is calling? The brand DERIVES FROM THE SECRET, never from the
 * payload (multi-brand PRD §3.8): the payload is caller-controlled, the secret
 * is not, and a lead filed under the wrong brand would send one brand's
 * customer another brand's emails. Each candidate secret is checked with the
 * same fail-closed, timing-safe comparison Marley's has always had, so an
 * unconfigured (or placeholder-short) per-brand secret simply never matches.
 * Returns the matched secret's slug, or null — the caller answers 401.
 */
export function resolveIngestBrand(
  authorizationHeader: string | null | undefined,
  secrets: readonly BrandIngestSecret[],
): string | null {
  for (const { brand, secret } of secrets) {
    if (ingestAuthorized(authorizationHeader, secret)) return brand;
  }
  return null;
}

/**
 * Does the body claim to be a different brand from the one its secret proves?
 *
 * The payload never CHOOSES the brand — but if it names one, it must agree
 * with the one the secret derived, and disagreement earns the same
 * uninformative 401 a bad secret gets. A caller holding brand A's secret and
 * posting brand B is misconfigured at best; either way it must not land a
 * lead under a brand it cannot authenticate for. An absent or null field
 * carries no claim (Marley's live site sends none) and is fine; anything else
 * — including a non-string — must equal the derived slug exactly.
 */
export function payloadBrandMismatch(body: unknown, derivedBrand: string): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const claimed = (body as { brand?: unknown }).brand;
  if (claimed === undefined || claimed === null) return false;
  return claimed !== derivedBrand;
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
