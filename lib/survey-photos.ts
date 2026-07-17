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
