import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Defect: the office survey gallery's cap starved a whole category.
 *
 * `loadSurveyPhotos` bounded the read at `created_at desc limit 60` over the
 * WHOLE lead, and the quote builder renders THREE widgets (access, large items,
 * cubic) that each filter that one list client-side. Keeping the newest 60
 * lead-wide discards the OLDEST rows — and on a real visit the access and
 * large-item shots are taken FIRST. So a big cubic survey, or twenty customer
 * /cv photos, could push the access widget to render short or empty while the
 * office believed it was seeing the whole visit.
 *
 * The seeds below are written to that chronology deliberately: access first,
 * then a large cubic survey. Against the pre-fix lead-wide cap the access
 * assertions fail outright.
 *
 * The second half is the other half of the same rule: whatever the cap DOES
 * hide has to be visible as a number, and a read that could not run must not
 * arrive as an empty gallery.
 */

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SURVEY = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let photosReadError: string | null = null;
let surveyReadError: string | null = null;

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  db.surveys = [{ id: SURVEY, lead_id: LEAD, created_at: "2026-09-01T00:00:00Z" }];
  db.survey_photos = [];
  photosReadError = null;
  surveyReadError = null;
}

/** Minimal PostgREST-shaped builder. `order` and `limit` are honoured (they ARE
 *  the fix under test) and `count` is the FULL filtered count, ignoring the
 *  limit — which is what `count: "exact"` returns. */
function builder(table: string) {
  const state = {
    filters: [] as Array<(r: Row) => boolean>,
    orderCol: null as string | null,
    ascending: true,
    take: Number.POSITIVE_INFINITY,
  };
  const run = () => {
    if (table === "survey_photos" && photosReadError) {
      return { data: null, error: { message: photosReadError }, count: null };
    }
    if (table === "surveys" && surveyReadError) {
      return { data: null, error: { message: surveyReadError }, count: null };
    }
    let hit = (db[table] ?? []).filter((r) => state.filters.every((f) => f(r)));
    if (state.orderCol) {
      const col = state.orderCol;
      hit = [...hit].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      if (!state.ascending) hit.reverse();
    }
    const total = hit.length;
    if (Number.isFinite(state.take)) hit = hit.slice(0, state.take);
    return { data: hit, error: null, count: total };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {};
  q.select = () => q;
  q.eq = (col: string, val: unknown) => (state.filters.push((r) => r[col] === val), q);
  q.order = (col: string, opts?: { ascending?: boolean }) => (
    (state.orderCol = col), (state.ascending = opts?.ascending !== false), q
  );
  q.limit = (n: number) => ((state.take = n), q);
  q.maybeSingle = async () => {
    const res = run();
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: res.error };
  };
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(resolve, reject);
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: builder }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({ id: "office-1", role: "admin", active: true, accessToken: "t" }),
}));
vi.mock("@/lib/storage/media-store", () => ({ createMediaStore: () => ({}) }));

import { loadSurveyPhotos } from "@/app/(dashboard)/leads/[id]/survey-actions";

const photo = (name: string, category: string, createdAt: string): Row => ({
  id: name,
  survey_id: SURVEY,
  category,
  storage_path: `${SURVEY}/${category}/${name}`,
  created_at: createdAt,
});

/** Two access shots taken on arrival, then a 60-item cubic walkthrough — the
 *  real chronology, and the one the lead-wide cap punished. */
function seedAccessThenBigCubic() {
  db.survey_photos = [
    photo("drive.jpg", "access", "2026-09-05T09:00:00Z"),
    photo("parking.jpg", "access", "2026-09-05T09:01:00Z"),
    ...Array.from({ length: 60 }, (_, i) =>
      photo(`cubic-${String(i).padStart(2, "0")}.jpg`, "cubic", `2026-09-05T10:${String(i).padStart(2, "0")}:00Z`),
    ),
  ];
}

beforeEach(reset);

describe("loadSurveyPhotos — one busy category cannot evict another", () => {
  it("still returns the ACCESS shots behind a 60-photo cubic survey", async () => {
    seedAccessThenBigCubic();
    const res = await loadSurveyPhotos(LEAD);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const access = res.photos.filter((p) => p.category === "access");
    expect(access.map((p) => p.id)).toEqual(["drive.jpg", "parking.jpg"]);
  });

  it("caps the busy category on its own and reports what it hid", async () => {
    seedAccessThenBigCubic();
    const res = await loadSurveyPhotos(LEAD);
    if (!res.ok) throw new Error("expected ok");
    const cubic = res.photos.filter((p) => p.category === "cubic");
    // Capped at the per-category ceiling, and `totals` still names the true
    // size so the widget can say "showing N of M" instead of truncating in
    // silence.
    expect(cubic.length).toBeLessThan(60);
    expect(res.totals.cubic).toBe(60);
    expect(res.totals.access).toBe(2);
    expect(res.totals.large_items).toBe(0);
  });

  it("keeps the NEWEST of a capped category — the shots just taken, not a fortnight ago", async () => {
    seedAccessThenBigCubic();
    const res = await loadSurveyPhotos(LEAD);
    if (!res.ok) throw new Error("expected ok");
    const cubic = res.photos.filter((p) => p.category === "cubic").map((p) => p.id);
    expect(cubic.at(-1)).toBe("cubic-59.jpg");
    // ...and handed back oldest-first within the category, which is the order
    // the widget appends new uploads to.
    expect(cubic[0] < (cubic.at(-1) as string)).toBe(true);
  });

  it("CONTROL: an ordinary survey comes back whole, with nothing hidden", async () => {
    db.survey_photos = [
      photo("drive.jpg", "access", "2026-09-05T09:00:00Z"),
      photo("sofa.jpg", "large_items", "2026-09-05T09:05:00Z"),
      photo("lounge.jpg", "cubic", "2026-09-05T09:10:00Z"),
    ];
    const res = await loadSurveyPhotos(LEAD);
    if (!res.ok) throw new Error("expected ok");
    expect(res.photos).toHaveLength(3);
    expect(res.totals).toEqual({ access: 1, large_items: 1, cubic: 1 });
  });

  it("a lead with no survey yet reports zeroes, not an unknown", async () => {
    db.surveys = [];
    const res = await loadSurveyPhotos(LEAD);
    if (!res.ok) throw new Error("expected ok");
    expect(res.photos).toEqual([]);
    expect(res.totals).toEqual({ access: 0, large_items: 0, cubic: 0 });
  });
});

describe("loadSurveyPhotos — a failed read is not an empty gallery", () => {
  it("refuses rather than returning zero photos when the photo read errors", async () => {
    seedAccessThenBigCubic();
    photosReadError = "column survey_photos.category does not exist";
    const res = await loadSurveyPhotos(LEAD);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("photos");
  });

  it("refuses when the SURVEY read errors, rather than reading it as a lead with no survey", async () => {
    seedAccessThenBigCubic();
    surveyReadError = "connection reset";
    const res = await loadSurveyPhotos(LEAD);
    expect(res.ok).toBe(false);
  });
});
