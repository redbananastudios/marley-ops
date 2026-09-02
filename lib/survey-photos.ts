/**
 * Survey photos — shared constants + path validation for the in-person survey
 * photo pipeline (quote builder). Photos live in the `survey-photos` LOGICAL
 * bucket, routed through the media-store seam so they follow the active driver
 * (Cloudflare R2 in prod, Supabase in dev). Paths are survey-anchored:
 * `<surveyId>/<category>/<uuid>.<ext>` — the upload-target server action
 * re-validates the prefix so a staff upload can never target another survey's
 * folder (the job-media validation-as-security-seam pattern).
 *
 * Pure module (no server-only import) so it is importable from server actions,
 * server loaders AND the client component. "use server" files cannot export a
 * const, which is why these live here rather than in survey-actions.ts.
 */

export const SURVEY_PHOTOS_BUCKET = "survey-photos";

export const SURVEY_PHOTO_CATEGORIES = ["access", "large_items", "cubic"] as const;
export type SurveyPhotoCategory = (typeof SURVEY_PHOTO_CATEGORIES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSurveyPhotoCategory(value: string): value is SurveyPhotoCategory {
  return (SURVEY_PHOTO_CATEGORIES as readonly string[]).includes(value);
}

/** `<surveyId>/<category>/<uuid>.<ext>` inside the survey-photos bucket. The
 *  folder must match the survey + category the caller resolved and the base
 *  name must be a fresh UUID, so a crafted path can't reach another survey's
 *  objects. Ext is bounded but permissive (camera files: jpg/jpeg/png/heic). */
export function isValidSurveyPhotoPath(path: string, surveyId: string, category: string): boolean {
  if (!UUID_RE.test(surveyId)) return false;
  if (!isSurveyPhotoCategory(category)) return false;
  const parts = path.split("/");
  if (parts.length !== 3) return false;
  if (parts[0] !== surveyId) return false;
  if (parts[1] !== category) return false;
  const file = parts[2];
  const dot = file.indexOf(".");
  if (dot <= 0) return false;
  const base = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (!UUID_RE.test(base)) return false;
  return /^[a-zA-Z0-9]{1,24}$/.test(ext);
}

/* ============================================================
 * Customer (/cv/<token>) uploads — a deliberately NARROWER surface
 * ============================================================
 *
 * The office widget above runs behind `requireOfficeProfile()`. The customer
 * half runs behind nothing but an unguessable share token, so the rules below
 * are stricter than the office path, never looser:
 *
 *  - the accepted type is decided by the FILE'S OWN LEADING BYTES, not by the
 *    `type` the browser reported. The office action takes `input.mime` on trust
 *    (any `image/*`); a token holder cannot smuggle a renamed script, and above
 *    all cannot store an SVG — SVG is an image the browser will EXECUTE, and a
 *    signed GET URL would serve it as its own document;
 *  - one token may add at most MAX_CUSTOMER_SURVEY_PHOTOS objects to its survey.
 *    That ceiling is ENFORCED IN THE DATABASE (`add_customer_survey_photo`,
 *    migration 0117) — the constant here is the number the copy quotes and the
 *    number the route hands the function, never the guard itself.
 *
 * Both are pure functions on purpose: the security decision is unit-testable
 * without a database, a bucket or a session.
 */

/** Customer uploads only ever land in the cubic category — the volume survey is
 *  the only thing the /cv page asks them about. */
export const CUSTOMER_SURVEY_PHOTO_CATEGORY: SurveyPhotoCategory = "cubic";

/** Per-survey ceiling on customer-uploaded photos. Paired with the byte cap in
 *  lib/storage/upload-limits.ts, this bounds one share token's total write. */
export const MAX_CUSTOMER_SURVEY_PHOTOS = 20;

export interface SniffedSurveyPhoto {
  /** Content type to STORE the object as — derived from the bytes, never from
   *  the client's declared type. */
  mime: string;
  /** File extension for the server-generated object key. */
  ext: string;
}

/** What the customer widget advertises, and what `accept` on its file input
 *  asks the OS picker for. Kept beside the sniffer so the copy and the
 *  allowlist can never drift apart. */
export const CUSTOMER_PHOTO_ACCEPT_ATTR = "image/jpeg,image/png";
export const CUSTOMER_PHOTO_TYPES_LABEL = "JPEG or PNG";
/** Browser-declared types the widget's courtesy pre-filter lets through. The
 *  server still decides from the bytes; this only saves a round trip. */
export const CUSTOMER_PHOTO_CLIENT_TYPES: readonly string[] = ["image/jpeg", "image/jpg", "image/png"];
/** One sentence of plain UK English telling an iPhone owner what to do, since
 *  iOS defaults to HEIC and HEIC is exactly what we refuse. Shared by the
 *  widget and the route so the customer is told the same thing either way. */
export const CUSTOMER_PHOTO_HEIC_HINT =
  "iPhone photos are usually HEIC. Set Settings › Camera › Formats to “Most Compatible” and take the photo again, and it will save as a JPEG.";

const matches = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/**
 * Identify an image from its magic bytes. Returns `null` for anything not on
 * the allowlist — including a valid image type we deliberately do not accept
 * (SVG, GIF, WebP, HEIC) and including an empty buffer. `null` means REFUSE;
 * there is no "assume JPEG" fallback, because that is exactly how a non-image
 * gets stored under an image content type.
 *
 * **JPEG and PNG only, deliberately** (finding B1, 2026-09-02). The allowlist
 * used to include WebP and HEIC, and the customer route names the returned
 * `ext` in the object key — so a customer's WebP landed as `<uuid>.webp`. Two
 * things downstream cannot survive that:
 *
 *  - `lib/job-sheet-load.ts` embeds survey photos in the crew day sheet through
 *    pdfmake, which dispatches on the file's OWN magic bytes. A WebP declared
 *    as JPEG makes it throw "Unknown image format"; `lib/crew-sheet/dispatch.ts`
 *    catches that, leaves `pdfBase64` null and the guarded send never fires — so
 *    EVERY crew member rostered that day gets no sheet at all, for all of their
 *    jobs, repeating on every retry;
 *  - HEIC cannot be decoded by desktop Chrome, Firefox or Edge, so the office
 *    tile the customer's photo exists to fill renders broken.
 *
 * The set is therefore "what a browser renders everywhere AND pdfmake can
 * embed", and `lib/job-sheet-load.ts` re-uses this same function to decide what
 * it may put in a PDF rather than guessing a content type from a file
 * extension.
 */
export function sniffSurveyPhotoImage(bytes: Uint8Array): SniffedSurveyPhoto | null {
  if (bytes.length < 12) return null;
  // JPEG — FF D8 FF
  if (matches(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  // PNG — 89 "PNG" CR LF 1A LF
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  return null;
}
