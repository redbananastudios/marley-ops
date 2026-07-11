export interface EvidenceFrame {
  t: number;
  blob: Blob;
}

function waitForEvent(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Video could not be decoded for evidence frames."));
    };
    const cleanup = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Frame compression failed."))),
      "image/jpeg",
      quality,
    );
  });
}

export async function extractEvidenceFrames(
  source: Blob,
  options: { everySeconds?: number; maxFrames?: number; maxWidth?: number } = {},
): Promise<EvidenceFrame[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  const url = URL.createObjectURL(source);
  video.src = url;

  try {
    await waitForEvent(video, "loadedmetadata");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) return [];
    const every = Math.max(2, options.everySeconds ?? duration / 40);
    const maxFrames = Math.max(1, options.maxFrames ?? 40);
    const timestamps = Array.from(
      { length: Math.min(maxFrames, Math.max(1, Math.ceil(duration / every))) },
      (_, index) => Math.min(duration - 0.05, index * every + 0.1),
    );
    timestamps[timestamps.length - 1] = Math.max(0.1, duration - 0.1);
    const width = Math.min(options.maxWidth ?? 960, video.videoWidth || 960);
    const height = Math.max(1, Math.round(width * ((video.videoHeight || 720) / (video.videoWidth || 1280))));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");

    const frames: EvidenceFrame[] = [];
    for (const t of timestamps) {
      video.currentTime = t;
      await waitForEvent(video, "seeked");
      if ("requestVideoFrameCallback" in video) {
        await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
      }
      context.drawImage(video, 0, 0, width, height);
      let blob = await canvasBlob(canvas, 0.75);
      if (blob.size > 307_200) blob = await canvasBlob(canvas, 0.55);
      if (blob.size > 307_200) throw new Error("A video frame could not be compressed below 300 KB.");
      frames.push({ t: Math.round(t * 10) / 10, blob });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}
