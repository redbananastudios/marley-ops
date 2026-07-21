/**
 * Client-declared upload size ceilings. Shared by the photo-capture clients (a
 * friendly pre-check) and the server actions that mint the presigned target
 * (the real enforcement — the action rejects an over-cap size AND binds the R2
 * presigned PUT to the declared byte count, so the browser can't upload more
 * than it declared). Videos have their own larger cap in lib/job-media.ts.
 *
 * 30 MB is comfortable headroom over any real phone capture (JPEG/HEIC are
 * ~2–12 MB even at high resolution) while stopping an accidental or abusive
 * multi-hundred-MB upload from landing in R2.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 30 * 1024 * 1024;

/** Human label for the cap, for error copy. */
export const MAX_IMAGE_UPLOAD_LABEL = "30 MB";

/** Presigned uploads must always carry a trustworthy, finite Content-Length.
 * Optional or non-integer sizes would bypass the server-side cap and leave the
 * storage provider to accept an unbounded body. */
export function isValidDeclaredUploadSize(bytes: unknown, maxBytes: number): bytes is number {
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maxBytes;
}
