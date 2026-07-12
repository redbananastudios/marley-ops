type CameraZoomCapabilities = MediaTrackCapabilities & {
  zoom?: { min: number; max: number; step: number };
};

type CameraZoomConstraint = MediaTrackConstraintSet & { zoom: number };

/** Ask for the widest view the browser exposes without blocking capture. */
export async function applyMinimumCameraZoom(track: MediaStreamTrack): Promise<boolean> {
  const capabilities = track.getCapabilities?.() as CameraZoomCapabilities | undefined;
  const minimumZoom = capabilities?.zoom?.min;
  if (typeof minimumZoom !== "number" || !Number.isFinite(minimumZoom)) return false;

  try {
    await track.applyConstraints({ advanced: [{ zoom: minimumZoom } as CameraZoomConstraint] });
    return true;
  } catch {
    return false;
  }
}
