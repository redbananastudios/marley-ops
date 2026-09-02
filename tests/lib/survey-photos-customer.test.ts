import { describe, expect, it } from "vitest";

import {
  CUSTOMER_PHOTO_ACCEPT_ATTR,
  CUSTOMER_PHOTO_CLIENT_TYPES,
  CUSTOMER_PHOTO_HEIC_HINT,
  CUSTOMER_PHOTO_TYPES_LABEL,
  MAX_CUSTOMER_SURVEY_PHOTOS,
  isValidSurveyPhotoPath,
  sniffSurveyPhotoImage,
} from "@/lib/survey-photos";

/**
 * QA-20260827-04 — the customer half of the survey-photo pipeline is an
 * UNAUTHENTICATED surface (the /cv share token is the only credential), so the
 * type decision must come from the file's own bytes. These tests pin that the
 * sniffer is an allowlist that FAILS CLOSED: anything it does not positively
 * recognise returns null, which the upload route treats as "refuse", never as
 * "assume JPEG".
 */

const bytes = (...values: number[]) => Uint8Array.from(values);
/** Pad to 12 bytes — the sniffer's minimum readable header. */
const padded = (head: number[], length = 32): Uint8Array => {
  const out = new Uint8Array(Math.max(length, head.length));
  out.set(head, 0);
  return out;
};
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

describe("sniffSurveyPhotoImage — what a customer may upload", () => {
  it("accepts JPEG and PNG, and names the extension to store", () => {
    expect(sniffSurveyPhotoImage(padded([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
    expect(sniffSurveyPhotoImage(padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });

  it("REFUSES a WebP — pdfmake would kill the whole crew day sheet over one (B1)", () => {
    // The route names the returned `ext` in the object key, so a WebP landed as
    // `<uuid>.webp` and lib/job-sheet-load.ts then declared it `image/jpeg`.
    // pdfmake dispatches on the magic bytes, throws "Unknown image format", and
    // lib/crew-sheet/dispatch.ts leaves pdfBase64 null with the guarded send
    // never firing — so every crew member rostered that day gets no sheet at
    // all, for all their jobs, on every retry.
    expect(sniffSurveyPhotoImage(padded([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBeNull();
  });

  it("REFUSES a HEIC — desktop Chrome/Firefox/Edge cannot decode it (B1)", () => {
    // iPhone stills: ISO-BMFF `ftyp` box at offset 4 with a HEIF brand. Storing
    // one leaves the estimator looking at a broken tile, which defeats the
    // whole point of letting the customer send a photo.
    expect(sniffSurveyPhotoImage(padded([0, 0, 0, 0x18, ...ascii("ftypheic")]))).toBeNull();
    expect(sniffSurveyPhotoImage(padded([0, 0, 0, 0x18, ...ascii("ftypmif1")]))).toBeNull();
  });

  it("REFUSES an SVG — an image the browser executes, served from the signed-URL origin", () => {
    expect(sniffSurveyPhotoImage(padded(ascii("<svg xmlns='http://www.w3.org/2000/svg'>")))).toBeNull();
    expect(sniffSurveyPhotoImage(padded(ascii("<?xml version='1.0'?><svg>")))).toBeNull();
  });

  it("REFUSES non-images, however they are labelled", () => {
    expect(sniffSurveyPhotoImage(padded(ascii("%PDF-1.7 something")))).toBeNull();
    expect(sniffSurveyPhotoImage(padded(ascii("<?php system($_GET[0]); ?>")))).toBeNull();
    expect(sniffSurveyPhotoImage(padded([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // zip / docx
    expect(sniffSurveyPhotoImage(padded(ascii("GIF89a")))).toBeNull(); // image, but off the list
    // An mp4 also carries an `ftyp` box — nothing with one is accepted now.
    expect(sniffSurveyPhotoImage(padded([0, 0, 0, 0x18, ...ascii("ftypisom")]))).toBeNull();
  });

  it("REFUSES an empty or truncated buffer rather than guessing", () => {
    expect(sniffSurveyPhotoImage(new Uint8Array(0))).toBeNull();
    expect(sniffSurveyPhotoImage(bytes(0xff, 0xd8, 0xff))).toBeNull(); // a JPEG header, but too short to read
  });

  it("does not accept a JPEG signature that starts one byte late (no scanning)", () => {
    expect(sniffSurveyPhotoImage(padded([0x00, 0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("what the widget PROMISES matches what the server accepts", () => {
  // The widget advertised "JPEG, PNG, WebP or HEIC" while the sheet pipeline
  // could survive only two of those. Copy that over-promises on an
  // unauthenticated surface is not cosmetic: it is an instruction to the
  // customer to do the thing that breaks the crew's day.
  it("advertises only the formats the sniffer actually returns", () => {
    expect(CUSTOMER_PHOTO_TYPES_LABEL).toBe("JPEG or PNG");
    expect(CUSTOMER_PHOTO_TYPES_LABEL).not.toMatch(/WebP|HEIC/i);
  });

  it("asks the OS picker for exactly those types", () => {
    expect(CUSTOMER_PHOTO_ACCEPT_ATTR.split(",").sort()).toEqual(["image/jpeg", "image/png"]);
    expect(CUSTOMER_PHOTO_ACCEPT_ATTR).not.toContain("image/*");
  });

  it("keeps the client-side courtesy filter inside the server's allowlist", () => {
    for (const type of CUSTOMER_PHOTO_CLIENT_TYPES) {
      expect(["image/jpeg", "image/jpg", "image/png"]).toContain(type);
    }
  });

  it("tells an iPhone owner what to do instead of just refusing", () => {
    expect(CUSTOMER_PHOTO_HEIC_HINT).toMatch(/HEIC/);
    expect(CUSTOMER_PHOTO_HEIC_HINT).toMatch(/Most Compatible/i);
    expect(CUSTOMER_PHOTO_HEIC_HINT).toMatch(/JPEG/);
  });
});

describe("customer upload caps and paths", () => {
  it("caps how many photos one share token may add", () => {
    expect(MAX_CUSTOMER_SURVEY_PHOTOS).toBeGreaterThan(0);
    expect(MAX_CUSTOMER_SURVEY_PHOTOS).toBeLessThanOrEqual(50);
  });

  it("still validates the customer key shape against the survey it claims", () => {
    const survey = "11111111-2222-4333-8444-555555555555";
    const other = "99999999-8888-4777-8666-555555555555";
    const file = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(isValidSurveyPhotoPath(`${survey}/cubic/${file}.jpg`, survey, "cubic")).toBe(true);
    expect(isValidSurveyPhotoPath(`${other}/cubic/${file}.jpg`, survey, "cubic")).toBe(false);
    expect(isValidSurveyPhotoPath(`${survey}/../${file}.jpg`, survey, "cubic")).toBe(false);
  });
});
