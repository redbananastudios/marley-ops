import { describe, expect, it, vi } from "vitest";

import { applyMinimumCameraZoom } from "@/lib/ai/camera";

function cameraTrack(minimumZoom?: number, rejects = false) {
  const applyConstraints = rejects
    ? vi.fn().mockRejectedValue(new Error("unsupported"))
    : vi.fn().mockResolvedValue(undefined);
  return {
    getCapabilities: vi.fn(() => minimumZoom === undefined ? {} : { zoom: { min: minimumZoom, max: 4, step: 0.1 } }),
    applyConstraints,
  } as unknown as MediaStreamTrack;
}

describe("applyMinimumCameraZoom", () => {
  it("requests the widest zoom exposed by the camera", async () => {
    const track = cameraTrack(0.5);

    await expect(applyMinimumCameraZoom(track)).resolves.toBe(true);
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 0.5 }] });
  });

  it("does nothing when zoom capabilities are unavailable", async () => {
    const track = cameraTrack();

    await expect(applyMinimumCameraZoom(track)).resolves.toBe(false);
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  it("keeps capture available when a device rejects the constraint", async () => {
    await expect(applyMinimumCameraZoom(cameraTrack(1, true))).resolves.toBe(false);
  });
});
