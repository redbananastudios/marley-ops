/**
 * Job content capture — pure helpers (docs/job-content-capture-prd.md v1.0).
 * Validation is the security seam: storage paths are lead-anchored and every
 * server action re-validates the prefix so a row can never point at another
 * customer's file (the proven job-notes pattern).
 */

export const JOB_MEDIA_BUCKET = "job-media";

export const JOB_MEDIA_TAGS = ["before", "after", "access", "team", "story", "other"] as const;
export type JobMediaTag = (typeof JOB_MEDIA_TAGS)[number];

export type JobMediaKind = "photo" | "video" | "audio";
export type JobMediaConsent = "unset" | "granted" | "internal_only";

export const MAX_ITEMS_PER_SAVE = 12;
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // native-camera clips; TUS-resumable
export const MAX_AUDIO_SECONDS = 180;

const EXT_BY_KIND: Record<JobMediaKind, readonly string[]> = {
  photo: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
  video: ["mp4", "mov", "webm", "m4v", "3gp"],
  audio: ["m4a", "mp4", "webm", "ogg", "aac", "wav", "mp3"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<leadId>/<uuid>.<ext>` inside the job-media bucket, ext legal for the kind. */
export function isValidJobMediaPath(path: string, leadId: string, kind: JobMediaKind): boolean {
  if (!UUID_RE.test(leadId)) return false;
  const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.([a-z0-9]{2,5})$/i.exec(path);
  if (!m) return false;
  if (m[1].toLowerCase() !== leadId.toLowerCase()) return false;
  if (!UUID_RE.test(m[2])) return false;
  return EXT_BY_KIND[kind].includes(m[3].toLowerCase());
}

export interface CaptureItemInput {
  kind: JobMediaKind;
  path: string;
  mime?: string | null;
  bytes?: number | null;
  durationS?: number | null;
  caption?: string | null;
  tag?: string | null;
}

export type ValidatedCaptureItem = {
  kind: JobMediaKind;
  path: string;
  mime: string | null;
  bytes: number | null;
  durationS: number | null;
  caption: string;
  tag: JobMediaTag | null;
};

/** Validate a batch of captured items against the lead they claim to belong to. */
export function validateCaptureItems(
  items: CaptureItemInput[],
  leadId: string,
): { ok: true; items: ValidatedCaptureItem[] } | { ok: false; error: string } {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "Nothing to save." };
  if (items.length > MAX_ITEMS_PER_SAVE) {
    return { ok: false, error: `Up to ${MAX_ITEMS_PER_SAVE} items per save.` };
  }
  const out: ValidatedCaptureItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "photo" && item.kind !== "video" && item.kind !== "audio") {
      return { ok: false, error: "Unknown capture type." };
    }
    if (typeof item.path !== "string" || !isValidJobMediaPath(item.path, leadId, item.kind)) {
      return { ok: false, error: "A file didn't upload correctly — remove it and try again." };
    }
    if (seen.has(item.path)) return { ok: false, error: "Duplicate file in the batch." };
    seen.add(item.path);
    const bytes = Number(item.bytes);
    const durationS = Number(item.durationS);
    const tag = JOB_MEDIA_TAGS.includes(item.tag as JobMediaTag) ? (item.tag as JobMediaTag) : null;
    out.push({
      kind: item.kind,
      path: item.path,
      mime: typeof item.mime === "string" && item.mime.length <= 100 ? item.mime : null,
      bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null,
      durationS: Number.isFinite(durationS) && durationS > 0 ? Math.round(durationS) : null,
      caption: (item.caption ?? "").trim().slice(0, 300),
      tag,
    });
  }
  return { ok: true, items: out };
}

/** Audio containers the recorder may produce, in preference order — the
 *  recorder must runtime-detect (Safari emits mp4/AAC, Android webm/opus). */
export const AUDIO_MIME_CANDIDATES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function extForMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/3gpp": "3gp",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[base] ?? "bin";
}

/** Summary line for the lead timeline: "2 photos, a video + a voice note". */
export function captureSummary(items: readonly { kind: JobMediaKind }[]): string {
  const counts = { photo: 0, video: 0, audio: 0 };
  for (const item of items) counts[item.kind] += 1;
  const bits: string[] = [];
  if (counts.photo) bits.push(counts.photo === 1 ? "a photo" : `${counts.photo} photos`);
  if (counts.video) bits.push(counts.video === 1 ? "a video" : `${counts.video} videos`);
  if (counts.audio) bits.push(counts.audio === 1 ? "a voice note" : `${counts.audio} voice notes`);
  if (bits.length <= 1) return bits[0] ?? "";
  return `${bits.slice(0, -1).join(", ")} + ${bits[bits.length - 1]}`;
}
