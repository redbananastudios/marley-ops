import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The crew's photo window (finding B4, 2026-09-02).
 *
 * `loadPhotoDataUris` and `loadPhotoSignedUrls` both read a survey's photos
 * OLDEST FIRST under a small cap — the multi-job crew day sheet passes cap = 3,
 * so it only ever sees six rows. The /cv link goes to the customer BEFORE the
 * survey visit, so every customer photo is older than every estimator photo on
 * the same survey. Without a discriminator the crew's driveway and parking
 * ACCESS shots stop reaching the sheet entirely and are never even fetched.
 *
 * These tests are written against that ordering deliberately: the seed puts the
 * customer photos first in time, which is the real-world shape, and asserts the
 * ACCESS photos still come out.
 */

const SURVEY = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

const head = (bytes: number[], length = 64) => {
  const out = new Uint8Array(length);
  out.set(bytes, 0);
  return out;
};
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const JPEG = () => head([0xff, 0xd8, 0xff, 0xe0]);
const PNG = () => head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = () => head([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]);

type Row = {
  category: string;
  storage_path: string;
  caption: string | null;
  survey_id: string;
  customer_uploaded: boolean;
  created_at: string;
};

let rows: Row[] = [];
const objects = new Map<string, Uint8Array>();
/** When set, every survey_photos select RESOLVES with `{data:null,error}` —
 *  which is what supabase-js does (it does not throw), and is exactly how a
 *  PostgREST rejection reached both readers as "this survey has no photos". */
let readError: { message: string; code?: string } | null = null;

vi.mock("@/lib/storage/media-store", () => ({
  createMediaStore: () => ({
    async getObject(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`no such object ${key}`);
      return bytes;
    },
    async createSignedGetUrl(key: string) {
      return `https://example.test/${key}?sig=1`;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

/** Minimal PostgREST-shaped builder. `eq` is honoured (that IS the fix under
 *  test), `order` is asc-only, `limit` truncates. */
function admin() {
  return {
    from(table: string) {
      if (table !== "survey_photos") throw new Error(`unexpected table ${table}`);
      const filters: Array<(r: Row) => boolean> = [];
      let take = Number.POSITIVE_INFINITY;
      const q = {
        select: () => q,
        eq: (col: keyof Row, val: unknown) => {
          filters.push((r) => r[col] === val);
          return q;
        },
        order: () => q,
        limit: (n: number) => {
          take = n;
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (readError) return Promise.resolve({ data: null, error: readError }).then(resolve);
          const hit = rows
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .slice(0, take);
          return Promise.resolve({ data: hit, error: null }).then(resolve);
        },
      };
      return q;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

import { loadPhotoDataUris, loadPhotoSignedUrls } from "@/lib/job-sheet-load";

const photo = (
  name: string,
  category: string,
  customerUploaded: boolean,
  createdAt: string,
  bytes: Uint8Array = JPEG(),
): Row => {
  const storage_path = `${SURVEY}/${category}/${name}`;
  objects.set(storage_path, bytes);
  return {
    category,
    storage_path,
    caption: null,
    survey_id: SURVEY,
    customer_uploaded: customerUploaded,
    created_at: createdAt,
  };
};

beforeEach(() => {
  rows = [];
  objects.clear();
  readError = null;
});

/** Six customer photos sent days before the visit, then the estimator's two
 *  access shots taken on the day — the real chronology. */
function seedCustomerThenAccess() {
  rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      photo(`cust-${i}.jpg`, "cubic", true, `2026-09-01T0${i}:00:00Z`),
    ),
    photo("drive.jpg", "access", false, "2026-09-05T09:00:00Z"),
    photo("parking.jpg", "access", false, "2026-09-05T09:05:00Z"),
  ];
}

describe("loadPhotoDataUris — the crew day sheet's PDF window", () => {
  it("still reaches the estimator's ACCESS photos when 6 older customer photos exist (B4)", async () => {
    seedCustomerThenAccess();
    // cap 3 is what lib/crew-sheet/dispatch.ts passes for a multi-job day.
    const out = await loadPhotoDataUris(admin(), SURVEY, 3);
    expect(out.map((p) => p.label)).toEqual(["Access", "Access"]);
    expect(out).toHaveLength(2);
  });

  it("excludes customer photos even when they are the only photos", async () => {
    rows = Array.from({ length: 4 }, (_, i) =>
      photo(`cust-${i}.jpg`, "cubic", true, `2026-09-01T0${i}:00:00Z`),
    );
    expect(await loadPhotoDataUris(admin(), SURVEY, 3)).toEqual([]);
  });

  it("CONTROL: office photos still come through, and keep their real content type", async () => {
    rows = [
      photo("a.jpg", "access", false, "2026-09-05T09:00:00Z", JPEG()),
      photo("b.png", "large_items", false, "2026-09-05T09:01:00Z", PNG()),
    ];
    const out = await loadPhotoDataUris(admin(), SURVEY, 3);
    expect(out).toHaveLength(2);
    expect(out[0].dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out[1].dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("DROPS an object whose bytes pdfmake cannot embed rather than mislabelling it (B1)", async () => {
    // The old code was `endsWith(".png") ? png : jpeg`, so this WebP would have
    // been declared image/jpeg. pdfmake dispatches on the magic bytes, throws,
    // and lib/crew-sheet/dispatch.ts leaves pdfBase64 null — so nobody rostered
    // that day gets a sheet at all, for any of their jobs. One dropped tile is
    // the correct blast radius; the two good photos must still be there.
    rows = [
      photo("bad.jpg", "access", false, "2026-09-05T09:00:00Z", WEBP()),
      photo("good1.jpg", "access", false, "2026-09-05T09:01:00Z", JPEG()),
      photo("good2.png", "large_items", false, "2026-09-05T09:02:00Z", PNG()),
    ];
    const out = await loadPhotoDataUris(admin(), SURVEY, 3);
    expect(out).toHaveLength(2);
    expect(out.every((p) => !p.dataUri.includes("webp"))).toBe(true);
    expect(out[0].dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out[1].dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("a .png EXTENSION over non-PNG bytes is dropped, not trusted", async () => {
    rows = [photo("liar.png", "access", false, "2026-09-05T09:00:00Z", WEBP())];
    expect(await loadPhotoDataUris(admin(), SURVEY, 3)).toEqual([]);
  });
});

describe("loadPhotoSignedUrls — the /my-jobs and /sheet web windows", () => {
  it("also excludes customer photos, for the same oldest-first reason (B4)", async () => {
    seedCustomerThenAccess();
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out.map((p) => p.label)).toEqual(["Access", "Access"]);
  });

  it("CONTROL: office photos still sign", async () => {
    rows = [photo("a.jpg", "access", false, "2026-09-05T09:00:00Z")];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain(`${SURVEY}/access/a.jpg`);
  });

  it("drops an object the crew's browser cannot render, like its PDF sibling (B1)", async () => {
    // The B1 fix landed on loadPhotoDataUris only, so this reader — the one
    // behind /my-jobs/[id] and /sheet/[token], which is what a crew actually
    // opens on the morning of a move — still signed a HEIC and left a broken
    // tile. The office upload path names the object from `file.name`, so an
    // estimator's iPhone photo really does arrive as `.heic`.
    rows = [
      photo("IMG_0042.heic", "access", false, "2026-09-05T09:00:00Z"),
      photo("drive.jpg", "access", false, "2026-09-05T09:01:00Z"),
      photo("hall.PNG", "large_items", false, "2026-09-05T09:02:00Z"),
    ];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out.map((p) => p.url.split("?")[0])).toEqual([
      `https://example.test/${SURVEY}/access/drive.jpg`,
      `https://example.test/${SURVEY}/large_items/hall.PNG`,
    ]);
  });

  it("an unrenderable object costs the crew a slot no longer than it has to", async () => {
    // Over-read then filter then cap, exactly as the PDF sibling does: two good
    // photos must still fill a window of two even with a HEIC ahead of them.
    rows = [
      photo("IMG_0042.heic", "access", false, "2026-09-05T09:00:00Z"),
      photo("drive.jpg", "access", false, "2026-09-05T09:01:00Z"),
      photo("parking.jpg", "access", false, "2026-09-05T09:02:00Z"),
    ];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 2);
    expect(out).toHaveLength(2);
    expect(out.every((p) => !p.url.includes(".heic"))).toBe(true);
  });
});

/**
 * The extension allowlist is about what a BROWSER renders, not about what
 * pdfmake can embed — and narrowing it to `{jpg, jpeg, png}` quietly threw away
 * real photographs.
 *
 * `.jfif` is the case that matters: Chrome and Edge on Windows save a downloaded
 * JPEG under that extension, and the office upload path names the object from
 * `file.name`, so an estimator dragging an agent's photo or a floor plan out of
 * their downloads stores `<uuid>.jfif`. Those are JPEG bytes. They rendered on
 * the crew page before the filter existed and they must still render now.
 */
describe("loadPhotoSignedUrls — the allowlist keeps real photographs", () => {
  it("keeps every real-world JPEG spelling, including the .jfif Windows Chrome produces", async () => {
    rows = [
      photo("drive.jfif", "access", false, "2026-09-05T09:00:00Z"),
      photo("hall.jpe", "access", false, "2026-09-05T09:01:00Z"),
      photo("stairs.jfi", "large_items", false, "2026-09-05T09:02:00Z"),
      photo("porch.jif", "large_items", false, "2026-09-05T09:03:00Z"),
    ];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out.map((p) => p.url.split("?")[0].split("/").pop())).toEqual([
      "drive.jfif",
      "hall.jpe",
      "stairs.jfi",
      "porch.jif",
    ]);
  });

  it("keeps formats a browser renders but pdfmake cannot embed, rather than dropping both", async () => {
    // The disagreement with the PDF sibling runs ONE WAY on purpose: the crew
    // see these on their phone and not on paper. Dropping them here as well
    // would cost them the photograph outright.
    rows = [
      photo("yard.webp", "access", false, "2026-09-05T09:00:00Z"),
      photo("van.avif", "access", false, "2026-09-05T09:01:00Z"),
      photo("plan.gif", "large_items", false, "2026-09-05T09:02:00Z"),
      photo("scan.bmp", "large_items", false, "2026-09-05T09:03:00Z"),
    ];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out).toHaveLength(4);
  });

  it("still refuses what a desktop browser cannot decode, and what it would EXECUTE", async () => {
    // heic/heif render as a blank tile; svg is an image the browser runs as its
    // own document off a signed GET URL.
    rows = [
      photo("IMG_1.heic", "access", false, "2026-09-05T09:00:00Z"),
      photo("IMG_2.heif", "access", false, "2026-09-05T09:01:00Z"),
      photo("payload.svg", "access", false, "2026-09-05T09:02:00Z"),
      photo("keep.jpg", "access", false, "2026-09-05T09:03:00Z"),
    ];
    const out = await loadPhotoSignedUrls(admin(), SURVEY, 6);
    expect(out.map((p) => p.url.split("?")[0].split("/").pop())).toEqual(["keep.jpg"]);
  });
});

/**
 * A FAILED read is not an empty survey.
 *
 * supabase-js resolves with `{data:null,error}` rather than throwing, so both
 * readers used to turn a rejected select into `rows ?? []` — and the crew day
 * sheet was assembled, rendered and SENT carrying no photos and no complaint.
 * The live trigger is deploy order: both selects filter `customer_uploaded`, a
 * column that does not exist until 0117 has been applied AND PostgREST has
 * reloaded its cache, so a container that restarts first fails every one of
 * these reads at once (PGRST204).
 */
describe("both readers — a read that could not run must not look like an empty survey", () => {
  const PGRST204 = {
    message: "column survey_photos.customer_uploaded does not exist",
    code: "PGRST204",
  };

  it("loadPhotoDataUris throws on a rejected select instead of returning no photos", async () => {
    seedCustomerThenAccess();
    readError = PGRST204;
    await expect(loadPhotoDataUris(admin(), SURVEY, 3)).rejects.toThrow(/PGRST204/);
  });

  it("loadPhotoSignedUrls throws on a rejected select instead of returning no photos", async () => {
    seedCustomerThenAccess();
    readError = PGRST204;
    await expect(loadPhotoSignedUrls(admin(), SURVEY, 6)).rejects.toThrow(/PGRST204/);
  });

  it("leaves a structured log line behind, so a cron that degrades still has a record", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      readError = PGRST204;
      await expect(loadPhotoSignedUrls(admin(), SURVEY, 6)).rejects.toThrow();
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("job-sheet.survey_photos.read_failed"))).toBe(true);
      expect(lines.some((l) => l.includes("PGRST204"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("CONTROL: with no error the same seed still returns photos (the throw is the error path, not the path)", async () => {
    seedCustomerThenAccess();
    expect(await loadPhotoSignedUrls(admin(), SURVEY, 6)).toHaveLength(2);
  });
});
