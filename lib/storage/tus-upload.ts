"use client";

import { Upload } from "tus-js-client";

import type { MediaUploadTarget } from "@/lib/storage/media-store";

export function uploadToMediaTarget(input: {
  target: MediaUploadTarget;
  file: Blob;
  onProgress?: (percentage: number) => void;
}): Promise<void> {
  if (input.target.protocol !== "tus") {
    return Promise.reject(new Error("This upload protocol is not supported by the browser client."));
  }

  return new Promise((resolve, reject) => {
    const upload = new Upload(input.file, {
      endpoint: input.target.endpoint,
      headers: input.target.headers,
      metadata: input.target.metadata,
      chunkSize: input.target.chunkSizeBytes,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
      removeFingerprintOnSuccess: true,
      onError: reject,
      onProgress(bytesUploaded, bytesTotal) {
        input.onProgress?.(bytesTotal > 0 ? (bytesUploaded / bytesTotal) * 100 : 0);
      },
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }, reject);
  });
}
