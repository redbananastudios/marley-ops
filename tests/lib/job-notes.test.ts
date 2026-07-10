import { describe, expect, it } from "vitest";
import {
  isValidJobPhotoPath,
  MAX_NOTE_LENGTH,
  MAX_PHOTOS_PER_NOTE,
  validateJobNote,
} from "@/lib/job-notes";

const APPT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

describe("isValidJobPhotoPath", () => {
  it("accepts a photo under this appointment's folder", () => {
    expect(isValidJobPhotoPath(`${APPT}/abc-123.jpg`, APPT)).toBe(true);
    expect(isValidJobPhotoPath(`${APPT}/pic.HEIC`, APPT)).toBe(true);
  });

  it("rejects a path under ANOTHER job's folder (can't claim other jobs' files)", () => {
    expect(isValidJobPhotoPath(`${OTHER}/abc.jpg`, APPT)).toBe(false);
  });

  it("rejects traversal, wrong extensions and junk", () => {
    expect(isValidJobPhotoPath(`${APPT}/../secrets.jpg`, APPT)).toBe(false);
    expect(isValidJobPhotoPath(`${APPT}/note.pdf`, APPT)).toBe(false);
    expect(isValidJobPhotoPath(`${APPT}/`, APPT)).toBe(false);
    expect(isValidJobPhotoPath("", APPT)).toBe(false);
    expect(isValidJobPhotoPath(`${APPT}/x.jpg`, "not-a-uuid")).toBe(false);
  });
});

describe("validateJobNote", () => {
  it("accepts text-only and photo-only notes", () => {
    expect(validateJobNote("Dent on the wardrobe door", [], APPT)).toMatchObject({ ok: true });
    expect(validateJobNote("", [`${APPT}/a.jpg`], APPT)).toMatchObject({ ok: true });
  });

  it("rejects an empty note (nothing said, nothing shown)", () => {
    expect(validateJobNote("   ", [], APPT).ok).toBe(false);
  });

  it("rejects photos from another job's folder", () => {
    expect(validateJobNote("damage", [`${OTHER}/a.jpg`], APPT).ok).toBe(false);
  });

  it("caps the photo count and trims/clamps the body", () => {
    const tooMany = Array.from({ length: MAX_PHOTOS_PER_NOTE + 1 }, (_, i) => `${APPT}/p${i}.jpg`);
    expect(validateJobNote("x", tooMany, APPT).ok).toBe(false);

    const long = validateJobNote("  " + "y".repeat(MAX_NOTE_LENGTH + 50) + "  ", [], APPT);
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.body).toHaveLength(MAX_NOTE_LENGTH);
  });
});
