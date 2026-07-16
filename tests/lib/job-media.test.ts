import { describe, expect, it } from "vitest";
import {
  captureSummary,
  extForMime,
  isValidJobMediaPath,
  MAX_ITEMS_PER_SAVE,
  validateCaptureItems,
} from "@/lib/job-media";

const LEAD = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("isValidJobMediaPath — the security seam", () => {
  it("accepts <leadId>/<uuid>.<ext> with a kind-legal extension", () => {
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.jpg`, LEAD, "photo")).toBe(true);
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.mp4`, LEAD, "video")).toBe(true);
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.m4a`, LEAD, "audio")).toBe(true);
    expect(isValidJobMediaPath(`${LEAD.toUpperCase()}/${FILE}.jpg`, LEAD, "photo")).toBe(true);
  });

  it("refuses another lead's folder, traversal, wrong ext-for-kind, junk", () => {
    expect(isValidJobMediaPath(`${OTHER}/${FILE}.jpg`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath(`../${LEAD}/${FILE}.jpg`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.exe`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.mp4`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath(`${LEAD}/not-a-uuid.jpg`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath(`${LEAD}/${FILE}.jpg/extra`, LEAD, "photo")).toBe(false);
    expect(isValidJobMediaPath("", LEAD, "photo")).toBe(false);
  });
});

describe("validateCaptureItems", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    kind: "photo" as const,
    path: `${LEAD}/${FILE}.jpg`,
    mime: "image/jpeg",
    bytes: 123456,
    caption: "  wardrobe down the stairs  ",
    tag: "story",
    ...over,
  });

  it("normalises captions/tags and rounds numbers", () => {
    const v = validateCaptureItems([item()], LEAD);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.items[0].caption).toBe("wardrobe down the stairs");
      expect(v.items[0].tag).toBe("story");
      expect(v.items[0].bytes).toBe(123456);
    }
  });

  it("rejects wrong-lead paths, duplicates, unknown kinds, junk tags become null", () => {
    expect(validateCaptureItems([item({ path: `${OTHER}/${FILE}.jpg` })], LEAD).ok).toBe(false);
    expect(validateCaptureItems([item(), item()], LEAD).ok).toBe(false); // duplicate path
    expect(validateCaptureItems([item({ kind: "gif" })], LEAD).ok).toBe(false);
    const v = validateCaptureItems([item({ tag: "banana" })], LEAD);
    expect(v.ok && v.items[0].tag).toBe(null);
    expect(validateCaptureItems([], LEAD).ok).toBe(false);
    const many = Array.from({ length: MAX_ITEMS_PER_SAVE + 1 }, (_, i) =>
      item({ path: `${LEAD}/${FILE.slice(0, -2)}${String(i).padStart(2, "0")}.jpg` }),
    );
    expect(validateCaptureItems(many, LEAD).ok).toBe(false);
  });
});

describe("extForMime / captureSummary", () => {
  it("maps containers incl. codec suffixes", () => {
    expect(extForMime("audio/mp4")).toBe("m4a");
    expect(extForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extForMime("video/quicktime")).toBe("mov");
    expect(extForMime("image/heic")).toBe("heic");
    expect(extForMime("application/unknown")).toBe("bin");
  });

  it("reads naturally on the timeline", () => {
    expect(captureSummary([{ kind: "photo" }, { kind: "photo" }, { kind: "audio" }])).toBe(
      "2 photos + a voice note",
    );
    expect(captureSummary([{ kind: "video" }])).toBe("a video");
  });
});
