"use client";

import { Upload } from "tus-js-client";

import type { MediaUploadTarget } from "@/lib/storage/media-store";

export function uploadToMediaTarget(input: {
  target: MediaUploadTarget;
  file: Blob;
  onProgress?: (percentage: number) => void;
}): Promise<void> {
  const target = input.target;
  if (target.protocol === "multipart") {
    return (async () => {
      const completed: { partNumber: number; etag: string }[] = [];
      for (const part of target.parts) {
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
    upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }, reject);
  });
}
