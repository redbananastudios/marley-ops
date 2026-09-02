import "server-only";

/**
 * Token-authenticated survey-photo plumbing for /cv/<token>.
 *
 * Everything here treats the share token as the ONLY credential, so every entry
 * point re-resolves the survey FROM the token on every call. Nothing accepts a
 * survey id, a lead id or a storage path from the caller — those are derived,
 * never received (QA-20260827-04: the customer self-fill page had no photo
 * control at all, and the office actions it would have called are all behind
 * `requireOfficeProfile()`).
 *
 * Read failures REFUSE. A swallowed Supabase error here would read as "no such
 * token" (locking a real customer out with a wrong message) or as "zero photos
 * so far" (silently defeating the per-survey count cap), which is the swallowed
 * read family this codebase has now been bitten by repeatedly.
 *
 * NOT a "use server" module on purpose: it exports constants and non-action
 * helpers, and only the two callers under this route may reach it.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import {
  CUSTOMER_SURVEY_PHOTO_CATEGORY,
  MAX_CUSTOMER_SURVEY_PHOTOS,
  SURVEY_PHOTOS_BUCKET,
} from "@/lib/survey-photos";

type Admin = ReturnType<typeof createAdminClient>;

/** Same shape the page and the submit action already enforce. */
export const CV_TOKEN_RE = /^[\w-]{10,64}$/;

/** Signed read URLs live an hour, matching signSurveyPhotoUrls on the office side. */
const SIGNED_URL_TTL_SECONDS = 3600;

/** Media store bound to the survey-photos logical bucket (R2 in prod, Supabase
 *  in dev) — identical to the office side, so both halves write to one place. */
export const customerPhotoStore = () =>
  createMediaStore(process.env, { bucket: SURVEY_PHOTOS_BUCKET });

export interface CvSurveyContext {
  /** cubic_surveys.id — the row the token addresses. */
  cubicSurveyId: string;
  /** leads.id — always present for a real /cv link (the office mints the token
   *  from a lead), and the anchor the `surveys` row hangs off. */
  leadId: string;
  clientId: string | null;
}

export type CvSurveyResolution =
  | { ok: true; survey: CvSurveyContext }
  | { ok: false; error: string };

/**
 * Resolve the survey a share token addresses, refusing in exactly the states
 * `submitCubicCustomerAction` refuses in. The token is re-read from the
 * database on EVERY call — a token validated on a previous request proves
 * nothing about this one (it may have been finalised since).
 */
export async function resolveCvSurvey(token: string, admin: Admin): Promise<CvSurveyResolution> {
  if (!CV_TOKEN_RE.test(token)) return { ok: false, error: "This link isn't valid." };

  const { data: row, error } = await admin
    .from("cubic_surveys")
    .select("id, lead_id, client_id, status")
    .eq("share_token", token)
    .maybeSingle();
  // A failed read is NOT "no such token". Saying "this link isn't valid" to a
  // customer holding a perfectly good link would send them to the phone with a
  // wrong story, and would silently mask an outage.
  if (error) return { ok: false, error: "We couldn't check your link just now. Please try again shortly." };
  if (!row) return { ok: false, error: "This link isn't valid." };
  if (row.status === "complete") {
    return {
      ok: false,
      error: "This survey has already been finalised. Call us if anything has changed.",
    };
  }
  // No lead means no `surveys` row to anchor photos to, and no office screen
  // that would ever show them. Refuse honestly rather than inventing an
  // orphaned row nobody can read back.
  if (!row.lead_id) {
    return { ok: false, error: "Photos can't be added to this link. Please call us." };
  }
  return {
    ok: true,
    survey: { cubicSurveyId: row.id, leadId: row.lead_id, clientId: row.client_id },
  };
}

/**
 * Find (or create) the `surveys` row that `survey_photos.survey_id` references.
 * `survey_photos` points at `surveys`, NOT `cubic_surveys`, so the customer path
 * needs the same lazy row the office's `ensureSurveyForLead` creates — and must
 * pick the SAME one, or the office review page (which reads the lead's newest
 * survey) would not see what the customer sent.
 *
 * ONE STATEMENT, in the database. This used to be find-then-insert here, with
 * nothing behind it: `surveys_lead_idx` is not unique and cannot be (a lead
 * legitimately gathers more than one survey over its life). Two concurrent
 * FIRST uploads — the same customer on a phone and a laptop, or a slow request
 * they retried — therefore created two rows, and since EVERY reader on both
 * sides takes only the lead's NEWEST survey, a photo written against the loser
 * was invisible to the customer and the office forever and counted toward
 * nothing. `ensure_customer_survey_row` (migration 0117) serialises the whole
 * find-or-create on a per-lead advisory lock, which is the only place that
 * decision can be made safely.
 *
 * Returns null on any failure — the caller must refuse, never carry on with a
 * guess.
 */
export async function ensureSurveyRowForCustomer(
  admin: Admin,
  survey: CvSurveyContext,
): Promise<string | null> {
  const { data, error } = await admin.rpc("ensure_customer_survey_row", {
    p_lead_id: survey.leadId,
    p_client_id: survey.clientId,
  });
  if (error) return null;
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * The `surveys` row the office's own `ensureSurveyForLead` would pick — the
 * lead's newest — read-only. `{ ok: false }` is "could not read", which is not
 * the same answer as `{ ok: true, id: null }` ("this lead has no survey row").
 */
export async function findSurveyRowId(
  admin: Admin,
  leadId: string,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const { data, error } = await admin
    .from("surveys")
    .select("id")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, id: data?.id ?? null };
}

export interface CustomerPhotoRow {
  id: string;
  storagePath: string;
}

/**
 * The photos this token's customer has added. Scoped four ways — the token's
 * own survey row, the cubic category, `customer_uploaded` (the authoritative
 * discriminator, stamped by the upload RPC) and `uploaded_by is null` — so a
 * share token can never read back, or delete, a photo the office took inside
 * someone's home. The `uploaded_by` clause is kept as belt and braces: it is
 * strictly narrower, and it was the only marker before migration 0117.
 *
 * BOUNDED. The row set is capped at the same ceiling the database enforces on
 * writes, so a page render can never sign an unbounded number of URLs (each
 * signature is work, and on the R2 driver a network call). Rows beyond the cap
 * can only come from historic or hand-inserted data; dropping them is the safe
 * direction — the gallery is a convenience, the bound is not.
 *
 * `null` means the read FAILED. It does not mean "none": the caller must say so
 * rather than render an empty, reassuring gallery.
 */
export async function listCustomerPhotos(
  admin: Admin,
  surveyRowId: string,
): Promise<CustomerPhotoRow[] | null> {
  const { data, error } = await admin
    .from("survey_photos")
    .select("id, storage_path")
    .eq("survey_id", surveyRowId)
    .eq("category", CUSTOMER_SURVEY_PHOTO_CATEGORY)
    .eq("customer_uploaded", true)
    .is("uploaded_by", null)
    .order("created_at", { ascending: true })
    .limit(MAX_CUSTOMER_SURVEY_PHOTOS);
  if (error) return null;
  return (data ?? []).map((row) => ({ id: row.id, storagePath: row.storage_path }));
}

/**
 * Courtesy pre-count, so an upload that is obviously over the ceiling is
 * refused before its bytes are pushed into the bucket. It is NOT the guard:
 * `add_customer_survey_photo` (migration 0117) is, and it is the only thing
 * that can be — a count read in one statement and an insert in another cannot
 * bound anything under concurrency, however carefully it is written.
 *
 * Predicate deliberately MIRRORS the function's (`customer_uploaded` alone), so
 * the number quoted to the customer and the number the database enforces are
 * counting the same rows.
 *
 * `null` means the count could not be read — in which case the upload must be
 * refused, because a failed count that fell back to 0 would read as "plenty of
 * room" exactly when the database is unhappy.
 */
export async function countCustomerPhotos(
  admin: Admin,
  surveyRowId: string,
): Promise<number | null> {
  const { count, error } = await admin
    .from("survey_photos")
    .select("id", { count: "exact", head: true })
    .eq("survey_id", surveyRowId)
    .eq("customer_uploaded", true);
  if (error || typeof count !== "number") return null;
  return count;
}

export type CustomerPhotoInsert =
  | { status: "inserted"; photoId: string; isFirst: boolean; remaining: number }
  | { status: "capped" }
  | { status: "failed" };

/**
 * Insert the row for a customer photo, under the per-survey ceiling, ATOMICALLY.
 *
 * The whole decision lives in `add_customer_survey_photo` (migration 0117),
 * which locks the parent `surveys` row before it counts. That is what makes the
 * bound real: the previous shape — count here, insert there — let N concurrent
 * requests all read 0, all pass the cap and all write, and wrote one duplicate
 * "customer added photos" timeline row per racing request.
 *
 * `isFirst` comes back from inside the same locked window, so the caller's
 * once-only note is written exactly once without a second race — and it is a
 * stamp on the survey rather than "the count was 0", so deleting the photos does
 * not re-arm it.
 *
 * A failure is `failed`, never `capped` and never a silent success — the caller
 * has already put an object in the bucket and must clean it up either way.
 */
export async function insertCustomerPhoto(
  admin: Admin,
  surveyRowId: string,
  storagePath: string,
): Promise<CustomerPhotoInsert> {
  const { data, error } = await admin.rpc("add_customer_survey_photo", {
    p_survey_id: surveyRowId,
    p_storage_path: storagePath,
    p_max: MAX_CUSTOMER_SURVEY_PHOTOS,
  });
  if (error) return { status: "failed" };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: "failed" };
  if (row.capped) return { status: "capped" };
  if (!row.photo_id) return { status: "failed" };
  return {
    status: "inserted",
    photoId: row.photo_id,
    isFirst: row.is_first === true,
    remaining: typeof row.remaining === "number" ? row.remaining : 0,
  };
}

/** Short-lived signed GET URLs for paths we have already proved belong to this
 *  token's survey. A failure drops that one URL (the tile renders a placeholder)
 *  rather than failing the whole page. Bounded at the per-survey ceiling for the
 *  same reason listCustomerPhotos is: nothing on this unauthenticated surface
 *  may sign an unbounded number of objects in one render. */
export async function signCustomerPhotoUrls(input: string[]): Promise<Record<string, string>> {
  const paths = input.slice(0, MAX_CUSTOMER_SURVEY_PHOTOS);
  if (paths.length === 0) return {};
  let store: ReturnType<typeof customerPhotoStore>;
  try {
    store = customerPhotoStore();
  } catch {
    return {};
  }
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        return [path, await store.createSignedGetUrl(path, SIGNED_URL_TTL_SECONDS)] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );
  const urls: Record<string, string> = {};
  for (const [path, url] of entries) if (url) urls[path] = url;
  return urls;
}

/** The admin client every helper here expects. Kept local so callers under this
 *  route cannot accidentally hand in a session-scoped client. */
export const cvAdminClient = (): Admin => createAdminClient();
