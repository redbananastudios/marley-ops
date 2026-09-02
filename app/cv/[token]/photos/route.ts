import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { errorContext, log } from "@/lib/log";
import {
  isValidDeclaredUploadSize,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
} from "@/lib/storage/upload-limits";
import {
  CUSTOMER_PHOTO_HEIC_HINT,
  CUSTOMER_PHOTO_TYPES_LABEL,
  CUSTOMER_SURVEY_PHOTO_CATEGORY,
  MAX_CUSTOMER_SURVEY_PHOTOS,
  isValidSurveyPhotoPath,
  sniffSurveyPhotoImage,
} from "@/lib/survey-photos";
import {
  countCustomerPhotos,
  cvAdminClient,
  customerPhotoStore,
  ensureSurveyRowForCustomer,
  findSurveyRowId,
  insertCustomerPhoto,
  resolveCvSurvey,
  signCustomerPhotoUrls,
} from "../photo-store";

/**
 * POST /cv/<token>/photos — a customer attaches one photo to their own volume
 * survey (QA-20260827-04).
 *
 * PUBLIC route: the unguessable share token is the only credential, exactly as
 * on the /cv page itself and its submit action. Because there is no session
 * behind it, the file NEVER reaches storage through a target held by the
 * browser. The office widget mints a presigned/TUS target and lets the browser
 * PUT to it; that target is minted with the office user's own access token, and
 * the only token that would satisfy the Supabase driver here is the service-role
 * key — which must never leave the server. So the bytes come to us and we write
 * them through the media-store seam server-side. That also buys the control a
 * presigned PUT cannot have: we see the actual bytes, so the content type is
 * SNIFFED rather than believed.
 *
 * Every request re-derives everything from the token: the survey, the `surveys`
 * row, the object key. The client supplies exactly one thing, the file.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Multipart framing adds boundary + headers around the file; allow a little
 *  slack over the byte cap before refusing on Content-Length alone. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

const refuse = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const admin = cvAdminClient();

  // 1. The token, re-validated on THIS request. Never a survey id from the client.
  const resolved = await resolveCvSurvey(token, admin);
  if (!resolved.ok) return refuse(resolved.error, 403);
  const survey = resolved.survey;

  // 2. Cheap ceiling before we buffer anything, so an oversized body is refused
  //    at the door rather than after it has been read into memory.
  //
  //    A MISSING Content-Length is a REFUSAL, not a pass. This read used to be
  //    `Number(header ?? "")`, and `Number("")` is 0 — finite, under the cap, so
  //    the guard waved through exactly the request that had declared nothing.
  //    Control then reached `request.formData()`, which buffers the whole body
  //    into memory before `file.size` exists to be checked, so a chunked request
  //    with no Content-Length could stream an arbitrarily large body into the
  //    live process from a public, session-less endpoint. There is no
  //    reverse-proxy body cap in front of this. Browsers always send a length
  //    for a multipart FormData POST, so nothing legitimate is lost.
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader.trim());
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    return refuse("We couldn't read that upload. Please try again.", 411);
  }
  if (declared > MAX_IMAGE_UPLOAD_BYTES + MULTIPART_SLACK_BYTES) {
    return refuse(`That photo is too large. Keep it under ${MAX_IMAGE_UPLOAD_LABEL}.`, 413);
  }

  // 3. A survey that is already FULL is refused before a single body byte is
  //    read. Everything this needs — the token and the lead's survey row — is
  //    resolved already, so buffering ~30 MB into the process to discover there
  //    was never anywhere to put it is pure waste, and on a public, session-less
  //    route it is waste an attacker can repeat for free. The read is
  //    deliberately the READ-ONLY `findSurveyRowId`, not the find-or-CREATE
  //    below: nothing should write a row on the strength of a request whose
  //    payload has not been seen yet.
  //
  //    A failed read refuses. A lead with no survey row yet is "zero so far",
  //    which is the honest answer rather than a swallowed one — there is no row
  //    for a photo to hang off, so there are no photos.
  const preSurveyRow = await findSurveyRowId(admin, survey.leadId);
  if (!preSurveyRow.ok) {
    return refuse("We couldn't save that just now. Please try again shortly.", 503);
  }
  if (preSurveyRow.id) {
    const before = await countCustomerPhotos(admin, preSurveyRow.id);
    if (before === null) {
      return refuse("We couldn't save that just now. Please try again shortly.", 503);
    }
    if (before >= MAX_CUSTOMER_SURVEY_PHOTOS) {
      return refuse(
        `That's the most photos we can take on this link (${MAX_CUSTOMER_SURVEY_PHOTOS}). Call us if you have more to show us.`,
        409,
      );
    }
  }

  let file: File;
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File)) return refuse("No photo was attached.", 400);
    file = candidate;
  } catch {
    return refuse("That upload could not be read. Please try again.", 400);
  }

  // 4. Size, against the shared ceiling the office path uses. Empty and oversize
  //    are separate answers — telling someone a 0-byte file is "too large" sends
  //    them off resizing a photo that never made it out of the picker.
  if (file.size <= 0) return refuse("That file was empty. Please try again.", 400);
  if (!isValidDeclaredUploadSize(file.size, MAX_IMAGE_UPLOAD_BYTES)) {
    return refuse(`That photo is too large. Keep it under ${MAX_IMAGE_UPLOAD_LABEL}.`, 413);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Belt and braces: File.size is metadata, bytes.length is the truth.
  if (bytes.length === 0) return refuse("That file was empty. Please try again.", 400);
  if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    return refuse(`That photo is too large. Keep it under ${MAX_IMAGE_UPLOAD_LABEL}.`, 413);
  }

  // 5. Type, from the bytes. The browser's declared `file.type` is ignored
  //    entirely: it is attacker-controlled on an unauthenticated surface.
  //    JPEG and PNG ONLY — a stored WebP kills the whole crew day sheet (see
  //    sniffSurveyPhotoImage) and a stored HEIC renders as a broken tile in
  //    desktop Chrome/Firefox/Edge, which is the office surface this feature
  //    exists to fill. So tell an iPhone owner plainly how to send a JPEG
  //    rather than refusing at them.
  const sniffed = sniffSurveyPhotoImage(bytes);
  if (!sniffed) {
    return refuse(
      `We can only take ${CUSTOMER_PHOTO_TYPES_LABEL} photos. ${CUSTOMER_PHOTO_HEIC_HINT}`,
      415,
    );
  }

  // 6. The `surveys` row survey_photos.survey_id points at (find-or-create,
  //    serialised per lead inside the database — see ensureSurveyRowForCustomer).
  const surveyRowId = await ensureSurveyRowForCustomer(admin, survey);
  if (!surveyRowId) return refuse("We couldn't save that just now. Please try again shortly.", 503);

  // 7. Courtesy count, re-read now the row is certain and the bytes are in
  //    hand, so a survey that filled up while this photo was being read is
  //    refused before it goes into the bucket. A failed count still refuses —
  //    it must never read as "zero so far". The REAL ceiling is enforced by the
  //    database in step 9; this check passing proves nothing about whether there
  //    is room.
  const existing = await countCustomerPhotos(admin, surveyRowId);
  if (existing === null) {
    return refuse("We couldn't save that just now. Please try again shortly.", 503);
  }
  if (existing >= MAX_CUSTOMER_SURVEY_PHOTOS) {
    return refuse(
      `That's the most photos we can take on this link (${MAX_CUSTOMER_SURVEY_PHOTOS}). Call us if you have more to show us.`,
      409,
    );
  }

  // 8. Server-generated object key, scoped to the resolved survey. The client
  //    never influences the path, the folder or the extension.
  const path = `${surveyRowId}/${CUSTOMER_SURVEY_PHOTO_CATEGORY}/${randomUUID()}.${sniffed.ext}`;
  if (!isValidSurveyPhotoPath(path, surveyRowId, CUSTOMER_SURVEY_PHOTO_CATEGORY)) {
    // Unreachable unless the survey id is not a UUID; refuse rather than write
    // an object at an unvalidated key.
    return refuse("We couldn't save that just now. Please try again shortly.", 503);
  }

  try {
    await customerPhotoStore().putObject({
      objectKey: path,
      body: buffer,
      contentType: sniffed.mime,
    });
  } catch (error) {
    log.error("cv.photo.store_failed", { surveyRowId, ...errorContext(error) });
    return refuse("We couldn't save that photo. Please try again shortly.", 503);
  }

  // 9. The row — and the ceiling, and "was this the first?" — decided in ONE
  //    locked statement inside the database (add_customer_survey_photo,
  //    migration 0117). Everything above is courtesy; this is the guard. Doing
  //    it here rather than in JS is the whole point: a count in one statement
  //    and an insert in another cannot bound anything when two of the
  //    customer's own photos are in flight at once, which is the normal case
  //    for a multi-select on a phone.
  const dropObject = async () => {
    try {
      await customerPhotoStore().deleteObjects([path]);
    } catch (error) {
      log.error("cv.photo.orphan_cleanup_failed", { surveyRowId, ...errorContext(error) });
    }
  };

  const result = await insertCustomerPhoto(admin, surveyRowId, path);
  if (result.status === "capped") {
    // The pre-count said there was room and the database disagreed — a genuine
    // race with the customer's own other uploads. Do not leave the object.
    await dropObject();
    return refuse(
      `That's the most photos we can take on this link (${MAX_CUSTOMER_SURVEY_PHOTOS}). Call us if you have more to show us.`,
      409,
    );
  }
  if (result.status === "failed") {
    // Do not leave an object nobody has a pointer to.
    await dropObject();
    return refuse("We couldn't save that photo. Please try again shortly.", 503);
  }

  // The first customer photo on this survey is worth a line on the lead's
  // timeline. ONLY the first, ever: a customer sending twelve photos must not
  // write twelve rows (and must never send twelve emails — this deliberately
  // raises no alert, the survey submission already does that). `isFirst` is
  // decided inside the same locked window as the insert, so twelve simultaneous
  // uploads still produce exactly one; and it is decided from a STAMP on the
  // surveys row rather than from a live count, so a customer who deletes a
  // blurry photo and retakes it does not write the same line again each cycle.
  if (result.isFirst) {
    const { error: activityError } = await admin.from("activities").insert({
      lead_id: survey.leadId,
      client_id: survey.clientId,
      type: "note",
      summary: "Customer added photos to their cubic survey",
      meta: { cubic_survey_id: survey.cubicSurveyId, survey_id: surveyRowId, via: "cubic_customer_link" },
    });
    if (activityError) {
      // The photo IS saved; only the timeline note failed. Say so in the log
      // rather than failing the customer's upload over it.
      log.warn("cv.photo.activity_failed", { surveyRowId, error: activityError.message });
    }
  }

  const urls = await signCustomerPhotoUrls([path]);
  return NextResponse.json({
    ok: true,
    photo: { id: result.photoId, url: urls[path] ?? null },
    remaining: result.remaining,
  });
}
