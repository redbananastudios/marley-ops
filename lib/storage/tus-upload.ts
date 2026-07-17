"use client";

import { Upload } from "tus-js-client";

import type { MediaUploadTarget } from "@/lib/storage/media-store";

export interface MediaUploadControl {
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
}

export function uploadToMediaTarget(input: {
  target: MediaUploadTarget;
  file: Blob;
  onProgress?: (percentage: number) => void;
  onControl?: (control: MediaUploadControl) => void;
}): Promise<void> {
  const target = input.target;
  if (target.protocol === "put") {
    // Single presigned PUT straight to R2. XHR (not fetch) so the upload
    // progress bar actually moves; no resume — a drop restarts (the capture
    // UI already offers a Retry). Pause/resume are no-ops for a single PUT.
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      // Stall watchdog: a silently half-open mobile connection can leave the
      // upload pending forever with the bar frozen. Abort if no progress for
      // STALL_MS so it fails fast + retryable, never hangs (standing lesson:
      // browser media waits must always be bounded). Reset on every progress
      // tick, so a slow-but-moving upload is never wrongly killed.
      const STALL_MS = 45_000;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const clearWatch = () => {
        if (watchdog) clearTimeout(watchdog);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearWatch();
        fn();
      };
      const armWatch = () => {
        clearWatch();
        watchdog = setTimeout(() => {
          finish(() => {
            try {
              xhr.abort();
            } catch {
              /* already done */
            }
            reject(new Error("Upload stalled. Check your connection and retry."));
          });
        }, STALL_MS);
      };
      xhr.open("PUT", target.url);
      for (const [name, value] of Object.entries(target.headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (event) => {
        armWatch();
        if (event.lengthComputable && event.total > 0) {
          input.onProgress?.((event.loaded / event.total) * 100);
        }
      };
      xhr.onload = () =>
        finish(() => {
          if (xhr.status >= 200 && xhr.status < 300) {
            input.onProgress?.(100);
            resolve();
          } else {
            reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
          }
        });
      xhr.onerror = () =>
        finish(() => reject(new Error("Upload failed. Check your connection and retry.")));
      xhr.onabort = () => finish(() => reject(new Error("Upload cancelled.")));
      input.onControl?.({ pause: () => {}, resume: () => {}, isPaused: () => false });
      armWatch();
      xhr.send(input.file);
    });
  }

  if (target.protocol === "multipart") {
    return (async () => {
      let paused = false;
      let resume: (() => void) | null = null;
      input.onControl?.({
        pause: () => { paused = true; },
        resume: () => { paused = false; resume?.(); resume = null; },
        isPaused: () => paused,
      });
      const completed: { partNumber: number; etag: string }[] = [];
      for (const part of target.parts) {
        if (paused) await new Promise<void>((resolve) => { resume = resolve; });
        const start = (part.partNumber - 1) * target.partSizeBytes;
        const body = input.file.slice(start, start + target.partSizeBytes);
        const response = await fetch(part.url, { method: "PUT", headers: part.headers, body });
        if (!response.ok) throw new Error(`Multipart upload part ${part.partNumber} failed.`);
        completed.push({ partNumber: part.partNumber, etag: response.headers.get("etag") ?? "" });
        input.onProgress?.((Math.min(input.file.size, start + body.size) / input.file.size) * 100);
      }
      const response = await fetch(target.complete.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...target.complete.headers },
        body: JSON.stringify({ parts: completed }),
      });
      if (!response.ok) throw new Error("Multipart upload completion failed.");
    })();
  }

  return new Promise((resolve, reject) => {
    let paused = false;
    let aborting = Promise.resolve();
    const upload = new Upload(input.file, {
      endpoint: target.endpoint,
      headers: target.headers,
      metadata: target.metadata,
      chunkSize: target.chunkSizeBytes,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
      removeFingerprintOnSuccess: true,
      fingerprint: async () => [
        "marley-ai-media",
        target.objectKey,
        input.file.size,
        input.file.type,
      ].join("-"),
      onError: reject,
      onProgress(bytesUploaded, bytesTotal) {
        input.onProgress?.(bytesTotal > 0 ? (bytesUploaded / bytesTotal) * 100 : 0);
      },
      onSuccess: () => resolve(),
    });
    input.onControl?.({
      pause() {
        if (paused) return;
        paused = true;
        aborting = upload.abort(false).catch(reject);
      },
      resume() {
        if (!paused) return;
        paused = false;
        void aborting.then(() => upload.start());
      },
      isPaused: () => paused,
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      if (!paused) upload.start();
    }, reject);
  });
}
