"use client";

/**
 * Customer photo capture for /cv/<token> (QA-20260827-04).
 *
 * A deliberate sibling of components/quote/survey-photos.tsx rather than a
 * reuse of it: that component imports the office survey actions directly, and
 * every one of them is behind `requireOfficeProfile()`. Threading five injected
 * actions through it would have changed the office call site to serve a page
 * the office never opens. This one talks to exactly two things — the
 * token-scoped upload route and the token-scoped delete action — and holds no
 * survey id, lead id or storage path of its own.
 *
 * Client-side checks here are courtesy only. The real allowlist, size ceiling
 * and count cap are enforced server-side, where the customer cannot reach them.
 */

import { useCallback, useState, useTransition } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_LABEL } from "@/lib/storage/upload-limits";
import {
  CUSTOMER_PHOTO_ACCEPT_ATTR,
  CUSTOMER_PHOTO_CLIENT_TYPES,
  CUSTOMER_PHOTO_HEIC_HINT,
  CUSTOMER_PHOTO_TYPES_LABEL,
} from "@/lib/survey-photos";

export interface CustomerPhoto {
  id: string;
  url: string | null;
}

export function CustomerSurveyPhotos({
  uploadUrl,
  remove,
  initial,
  max,
  unavailable = false,
}: {
  /** `/cv/<token>/photos` — built server-side; the widget never assembles it. */
  uploadUrl: string;
  remove: (photoId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  initial: CustomerPhoto[];
  max: number;
  /** True when the existing photos could NOT be read. An empty gallery and a
   *  failed read must not look the same. */
  unavailable?: boolean;
}) {
  const [photos, setPhotos] = useState<CustomerPhoto[]>(initial);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [removing, startRemoving] = useTransition();
  const inputId = "cv-survey-photos";

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const chosen = Array.from(files);
      if (chosen.length === 0) return;

      const room = max - photos.length - uploading;
      if (room <= 0) {
        toast.error(`That's the most photos we can take on this link (${max}).`);
        return;
      }
      const queue = chosen.slice(0, room);
      if (queue.length < chosen.length) {
        toast.error(`Only ${queue.length} more ${queue.length === 1 ? "photo" : "photos"} can be added here.`);
      }
      const sized = queue.filter((file) => file.size > 0 && file.size <= MAX_IMAGE_UPLOAD_BYTES);
      if (sized.length < queue.length) {
        toast.error(`Photos over ${MAX_IMAGE_UPLOAD_LABEL} were skipped.`);
      }
      // Courtesy only — the server decides from the bytes. An empty `type` is
      // let through rather than guessed at (some browsers report nothing), so
      // this can only ever save a round trip, never be the reason a real photo
      // is refused. The common case it catches is an iPhone HEIC, where saying
      // so here is far kinder than a 415 after a 4 MB upload.
      const typed = sized.filter(
        (file) => !file.type || CUSTOMER_PHOTO_CLIENT_TYPES.includes(file.type.toLowerCase()),
      );
      if (typed.length < sized.length) {
        toast.error(`We can only take ${CUSTOMER_PHOTO_TYPES_LABEL} photos. ${CUSTOMER_PHOTO_HEIC_HINT}`);
      }
      if (typed.length === 0) return;

      setUploading((count) => count + typed.length);
      for (const file of typed) {
        try {
          const body = new FormData();
          body.append("file", file);
          const response = await fetch(uploadUrl, { method: "POST", body });
          const result = (await response.json().catch(() => null)) as
            | { ok: true; photo: CustomerPhoto }
            | { ok: false; error: string }
            | null;
          if (!response.ok || !result || result.ok !== true) {
            toast.error(result && result.ok === false ? result.error : "That photo could not be added.");
            continue;
          }
          setPhotos((prev) => [...prev, result.photo]);
        } catch {
          toast.error("That photo could not be added. Check your connection and try again.");
        } finally {
          setUploading((count) => Math.max(0, count - 1));
        }
      }
    },
    [max, photos.length, uploading, uploadUrl],
  );

  const removePhoto = useCallback(
    (photo: CustomerPhoto) => {
      startRemoving(async () => {
        const previous = photos;
        setPhotos((prev) => prev.filter((item) => item.id !== photo.id));
        const result = await remove(photo.id);
        if (!result.ok) {
          toast.error(result.error);
          setPhotos(previous);
        }
      });
    },
    [photos, remove],
  );

  const full = photos.length + uploading >= max;

  return (
    <div className="space-y-3">
      <p className="text-sm text-mist-500">
        Photos are optional, and they help a lot. A wide shot of each room, plus anything bulky or
        awkward, tells us what to bring.
      </p>

      {unavailable ? (
        <p className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-semibold text-warn">
          We couldn&apos;t load the photos already on this survey. Anything you add now will still be
          saved.
        </p>
      ) : null}

      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (!full && event.dataTransfer.files?.length) void uploadFiles(event.dataTransfer.files);
        }}
        className={cn(
          "flex min-h-[88px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed bg-card px-4 py-4 text-center transition",
          full ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          dragOver && !full ? "border-mm-red bg-accent" : "hover:bg-muted",
        )}
      >
        <Camera className="size-5 text-mist-400" strokeWidth={1.75} />
        <span className="text-sm font-medium text-foreground">
          {full ? `That's all ${max} photos` : "Tap to take a photo or add one"}
        </span>
        <span className="text-xs text-mist-400">
          {CUSTOMER_PHOTO_TYPES_LABEL}, up to {MAX_IMAGE_UPLOAD_LABEL} each
        </span>
        <span className="max-w-sm text-xs text-mist-400">{CUSTOMER_PHOTO_HEIC_HINT}</span>
        <input
          id={inputId}
          type="file"
          /* Narrowing this from image/* is not only honesty about what the
             server accepts: iOS converts a HEIC to JPEG on its way out of the
             picker when the accept list does not include HEIC, so most iPhone
             customers never meet the refusal at all. */
          accept={CUSTOMER_PHOTO_ACCEPT_ATTR}
          capture="environment"
          multiple
          disabled={full}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files?.length) void uploadFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </label>

      {uploading > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-mist-500" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
          Sending {uploading} {uploading === 1 ? "photo" : "photos"}...
        </p>
      ) : null}

      {photos.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="relative aspect-square overflow-hidden rounded-md border bg-muted">
              {photo.url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={photo.url} alt="Survey photo you added" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center px-1 text-center text-[10px] leading-tight text-mist-400">
                  Saved. Preview unavailable.
                </div>
              )}
              <button
                type="button"
                aria-label="Remove this photo"
                disabled={removing}
                onClick={() => removePhoto(photo)}
                className="focus-ring absolute right-1 top-1 flex size-8 items-center justify-center rounded-md bg-foreground/70 text-white backdrop-blur-sm transition hover:bg-mm-red disabled:opacity-50"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
