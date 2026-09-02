import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA-20260827-04 — a customer could not attach a photo to their own /cv volume
 * survey. The fix is an unauthenticated upload surface, so these tests are
 * written against the thing that matters about it: what it REFUSES.
 *
 * The share token is the only credential, so every case below drives the real
 * route/action with a token (or a deliberately wrong one) and then reads the
 * fake database and the fake bucket to see what actually landed. "The call
 * returned ok" is not the assertion; "a row exists, scoped to this survey, and
 * an object exists behind it" is.
 */

const TOKEN = "cv-token-abcdefghij";
const OTHER_TOKEN = "cv-token-zzzzzzzzzz";
const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER_LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SURVEY_ROW = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const OTHER_SURVEY_ROW = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const PHOTO_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

const head = (bytes: number[]) => {
  const out = new Uint8Array(64);
  out.set(bytes, 0);
  return out;
};
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const JPEG = () => head([0xff, 0xd8, 0xff, 0xe0]);
const PNG = () => head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = () => head(ascii("%PDF-1.7"));
/** "RIFF" ....(size).... "WEBP" — a real WebP header. Accepted before the B1
 *  fix; it lands as `<uuid>.webp`, and one of those on a survey takes the
 *  ENTIRE crew day sheet down for every crew member rostered that day. */
const WEBP = () => head([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]);
/** ISO-BMFF `ftyp` box with a HEIF still-image brand — what an iPhone emits by
 *  default, and what desktop Chrome/Firefox/Edge cannot decode. */
const HEIC = () => head([0, 0, 0, 0x18, ...ascii("ftypheic")]);

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const selectErrors: Record<string, string | null> = {};
const writeErrors: Record<string, string | null> = {};
let idSeq = 0;
/** Forces the route's COURTESY pre-count to report 0 however many rows exist,
 *  so a test can prove the ceiling is held by the database-side guard alone
 *  rather than by the JS read in front of it. */
let blindPreCount = false;
let rpcError: string | null = null;

/* ---------------- fake object store ---------------- */

const objects = new Map<string, { bytes: number; contentType: string }>();
let storeThrows = false;

vi.mock("@/lib/storage/media-store", () => ({
  createMediaStore: () => ({
    driver: "s3",
    bucket: "survey-photos",
    async putObject({
      objectKey,
      body,
      contentType,
    }: {
      objectKey: string;
      body: ArrayBuffer;
      contentType: string;
    }) {
      if (storeThrows) throw new Error("bucket unreachable");
      objects.set(objectKey, { bytes: body.byteLength, contentType });
      return { bytes: body.byteLength, contentType, etag: null, updatedAt: null };
    },
    async deleteObjects(keys: string[]) {
      for (const key of keys) objects.delete(key);
    },
    async createSignedGetUrl(key: string) {
      return `https://example.test/${key}?sig=1`;
    },
  }),
}));

/* ---------------- fake supabase ---------------- */

function builder(table: string) {
  const state = {
    op: "select" as "select" | "insert" | "update" | "delete",
    headCount: false,
    filters: [] as Array<(r: Row) => boolean>,
    inserted: [] as Row[],
    patch: {} as Row,
  };
  const run = () => {
    const rows = db[table] ?? [];
    if (state.op === "select" && selectErrors[table]) {
      return { data: null, error: { message: selectErrors[table] }, count: null };
    }
    if (state.op === "select" && state.headCount && blindPreCount) {
      return { data: null, error: null, count: 0 };
    }
    if (state.op === "insert") {
      if (writeErrors[table]) return { data: null, error: { message: writeErrors[table] }, count: null };
      for (const row of state.inserted) {
        // Real ids are UUIDs, and the route's own path validation rejects a
        // survey id that is not one — a `surveys-1` fake would pass a test the
        // production shape fails.
        idSeq += 1;
        if (row.id == null) row.id = crypto.randomUUID();
        if (row.created_at == null) row.created_at = new Date(2026, 0, 1, 0, 0, idSeq).toISOString();
        (db[table] ??= []).push(row);
      }
      return { data: state.inserted, error: null, count: null };
    }
    const hit = rows.filter((r) => state.filters.every((f) => f(r)));
    if (state.op === "delete") {
      if (writeErrors[table]) return { data: null, error: { message: writeErrors[table] }, count: null };
      db[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null, count: hit.length };
    }
    if (state.op === "update") {
      hit.forEach((r) => Object.assign(r, state.patch));
      return { data: hit, error: null, count: hit.length };
    }
    return { data: hit, error: null, count: hit.length };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {};
  q.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
    if (opts?.head) state.headCount = true;
    return q;
  };
  q.insert = (row: Row | Row[]) => (
    (state.op = "insert"),
    (state.inserted = (Array.isArray(row) ? row : [row]).map((r) => ({ ...r }))),
    q
  );
  q.update = (patch: Row) => ((state.op = "update"), (state.patch = patch), q);
  q.delete = () => ((state.op = "delete"), q);
  q.eq = (col: string, val: unknown) => (state.filters.push((r) => r[col] === val), q);
  q.neq = (col: string, val: unknown) => (state.filters.push((r) => r[col] !== val), q);
  q.is = (col: string, val: unknown) => (
    state.filters.push((r) => (val === null ? r[col] == null : r[col] === val)),
    q
  );
  q.order = () => q;
  q.limit = () => q;
  q.single = async () => {
    const res = run();
    const row = (res.data as Row[] | null)?.[0] ?? null;
    return { data: row, error: res.error ?? (row ? null : { message: "0 rows" }) };
  };
  q.maybeSingle = async () => {
    const res = run();
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: res.error };
  };
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(resolve, reject);
  return q;
}

/**
 * `add_customer_survey_photo` (migration 0117) modelled at its CONTRACT: it
 * counts and inserts as one indivisible step, and it — not the caller — decides
 * both `capped` and `is_first`. In Postgres that indivisibility comes from a
 * `for update` lock on the parent `surveys` row; here it comes from the handler
 * being one synchronous function, which is the same guarantee for the purposes
 * of these tests. Deliberately does NOT re-read anything the route computed:
 * the point of the finding is that the route may not be the one counting.
 */
function rpc(name: string, args: Record<string, unknown>) {
  if (name === "ensure_customer_survey_row") return ensureSurveyRowRpc(args);
  if (name !== "add_customer_survey_photo") {
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }
  if (rpcError) return Promise.resolve({ data: null, error: { message: rpcError } });
  if (writeErrors.survey_photos) {
    return Promise.resolve({ data: null, error: { message: writeErrors.survey_photos } });
  }
  const surveyId = args.p_survey_id as string;
  const max = args.p_max as number;
  // The real function raises P0002 when the parent row has gone.
  const surveyRow = (db.surveys ?? []).find((row) => row.id === surveyId);
  if (!surveyRow) {
    return Promise.resolve({ data: null, error: { message: "survey not found" } });
  }
  const before = (db.survey_photos ?? []).filter(
    (row) => row.survey_id === surveyId && row.customer_uploaded === true,
  ).length;
  if (before >= max) {
    return Promise.resolve({
      data: [{ photo_id: null, capped: true, is_first: false, remaining: 0 }],
      error: null,
    });
  }
  idSeq += 1;
  const row: Row = {
    id: crypto.randomUUID(),
    survey_id: surveyId,
    category: "cubic",
    storage_path: args.p_storage_path,
    uploaded_by: null,
    customer_uploaded: true,
    created_at: new Date(2026, 0, 1, 0, 0, idSeq).toISOString(),
  };
  (db.survey_photos ??= []).push(row);
  // `is_first` is a STAMP on the parent survey, read and written inside the same
  // locked window as the insert — NOT "the count was 0". Modelling it as the
  // count would let this suite pass while the customer's delete-and-retake
  // wrote the timeline note again on every cycle (C2).
  const isFirst = surveyRow.customer_photos_noted_at == null;
  if (isFirst) surveyRow.customer_photos_noted_at = new Date(2026, 0, 2).toISOString();
  return Promise.resolve({
    data: [
      {
        photo_id: row.id,
        capped: false,
        is_first: isFirst,
        remaining: Math.max(max - (before + 1), 0),
      },
    ],
    error: null,
  });
}

/**
 * `ensure_customer_survey_row` (migration 0117) modelled at its CONTRACT: one
 * indivisible find-or-create per lead. In Postgres that comes from a
 * transaction-scoped advisory lock keyed on the lead; here it comes from this
 * handler being one synchronous function, which is the same guarantee for these
 * tests. The point of the finding (C1) is that the ROUTE must not be the one
 * doing find-then-insert, so this deliberately re-reads nothing the route
 * computed.
 */
function ensureSurveyRowRpc(args: Record<string, unknown>) {
  if (rpcError) return Promise.resolve({ data: null, error: { message: rpcError } });
  if (selectErrors.surveys) {
    return Promise.resolve({ data: null, error: { message: selectErrors.surveys } });
  }
  const leadId = args.p_lead_id as string;
  const existing = (db.surveys ?? [])
    .filter((row) => row.lead_id === leadId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (existing) return Promise.resolve({ data: existing.id as string, error: null });
  if (writeErrors.surveys) {
    return Promise.resolve({ data: null, error: { message: writeErrors.surveys } });
  }
  idSeq += 1;
  const row: Row = {
    id: crypto.randomUUID(),
    lead_id: leadId,
    client_id: args.p_client_id ?? null,
    status: "scheduled",
    customer_photos_noted_at: null,
    created_at: new Date(2026, 0, 1, 0, 0, idSeq).toISOString(),
  };
  (db.surveys ??= []).push(row);
  return Promise.resolve({ data: row.id as string, error: null });
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder, rpc }) }));
vi.mock("@/lib/comms/dispatch", () => ({ sendOpsAlert: vi.fn() }));

const logged: { event: string; ctx: Record<string, unknown> }[] = [];
vi.mock("@/lib/log", () => ({
  log: {
    debug: (event: string, ctx: Record<string, unknown>) => logged.push({ event, ctx }),
    info: (event: string, ctx: Record<string, unknown>) => logged.push({ event, ctx }),
    warn: (event: string, ctx: Record<string, unknown>) => logged.push({ event, ctx }),
    error: (event: string, ctx: Record<string, unknown>) => logged.push({ event, ctx }),
  },
  errorContext: (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  redactedLogContext: (ctx: Record<string, unknown>) => ctx,
}));

import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/storage/upload-limits";
import { MAX_CUSTOMER_SURVEY_PHOTOS } from "@/lib/survey-photos";
import { POST } from "@/app/cv/[token]/photos/route";
import { deleteCubicCustomerPhotoAction } from "@/app/cv/[token]/actions";

function reset() {
  for (const key of Object.keys(db)) delete db[key];
  for (const key of Object.keys(selectErrors)) delete selectErrors[key];
  for (const key of Object.keys(writeErrors)) delete writeErrors[key];
  objects.clear();
  logged.length = 0;
  storeThrows = false;
  blindPreCount = false;
  rpcError = null;
  idSeq = 0;
  db.cubic_surveys = [
    { id: "cubic-1", share_token: TOKEN, lead_id: LEAD, client_id: CLIENT, status: "draft" },
    { id: "cubic-2", share_token: OTHER_TOKEN, lead_id: OTHER_LEAD, client_id: CLIENT, status: "draft" },
  ];
  db.surveys = [
    {
      id: SURVEY_ROW,
      lead_id: LEAD,
      client_id: CLIENT,
      status: "scheduled",
      customer_photos_noted_at: null,
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: OTHER_SURVEY_ROW,
      lead_id: OTHER_LEAD,
      client_id: CLIENT,
      status: "scheduled",
      customer_photos_noted_at: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  db.survey_photos = [];
  db.activities = [];
}

/**
 * Build the multipart request the way a browser does — body first, then a
 * REAL, honest Content-Length header. `new Request(url, { body: formData })`
 * sets no Content-Length at all (verified on Node 22 / undici), which is
 * exactly the shape the route must now refuse, so the tests would otherwise be
 * exercising the refusal path everywhere and proving nothing.
 *
 * `contentLength` overrides the honest value (or, when null, omits the header)
 * so the ceiling can be tested from both directions.
 */
async function multipartRequest(
  url: string,
  form: FormData,
  contentLength?: string | null,
): Promise<Request> {
  const framed = new Request(url, { method: "POST", body: form });
  const contentType = framed.headers.get("content-type") as string;
  const body = await framed.arrayBuffer();
  const headers = new Headers({ "content-type": contentType });
  const declared = contentLength === undefined ? String(body.byteLength) : contentLength;
  if (declared !== null) headers.set("content-length", declared);
  return new Request(url, { method: "POST", body, headers });
}

async function upload(
  token: string,
  file: File,
  extra: Record<string, string> = {},
  contentLength?: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  const request = await multipartRequest(`http://ops.test/cv/${token}/photos`, form, contentLength);
  const response = await POST(request, { params: Promise.resolve({ token }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const jpegFile = (name = "kitchen.jpg") => new File([JPEG()], name, { type: "image/jpeg" });

describe("POST /cv/<token>/photos", () => {
  beforeEach(reset);

  it("CONTROL: a valid token stores the object and records the row against the token's survey", async () => {
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(db.survey_photos).toHaveLength(1);
    const row = db.survey_photos[0];
    expect(row.survey_id).toBe(SURVEY_ROW); // the token's lead, not the other one
    expect(row.category).toBe("cubic");
    expect(row.uploaded_by).toBeNull();
    // The discriminator the crew day sheet filters on (0117). Without it the
    // customer's photos — always older than the estimator's, because the link
    // goes out before the visit — push the access shots off the sheet's
    // oldest-first window.
    expect(row.customer_uploaded).toBe(true);
    expect(String(row.storage_path)).toMatch(
      new RegExp(`^${SURVEY_ROW}/cubic/[0-9a-f-]{36}\\.jpg$`),
    );
    // The bytes really landed, under an image content type derived from them.
    const stored = objects.get(String(row.storage_path));
    expect(stored).toBeDefined();
    expect(stored!.bytes).toBe(64);
    expect(stored!.contentType).toBe("image/jpeg");
  });

  it("refuses an invalid token, and an unknown one, writing nothing", async () => {
    for (const bad of ["short", "not a token!", "cv-token-doesnotexist"]) {
      const res = await upload(bad, jpegFile());
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
    }
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("refuses once the office has FINALISED the survey (matching the submit action)", async () => {
    db.cubic_surveys[0].status = "complete";
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/finalised/i);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("still accepts photos after the customer has SUBMITTED — submitting is not a lock", async () => {
    db.cubic_surveys[0].status = "customer_submitted";
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(200);
    expect(db.survey_photos).toHaveLength(1);
  });

  it("refuses a disallowed type even when the browser swears it is a JPEG", async () => {
    const disguised = new File([PDF()], "invoice.jpg", { type: "image/jpeg" });
    const res = await upload(TOKEN, disguised);
    expect(res.status).toBe(415);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("accepts a PNG — the other half of the allowlist", async () => {
    const res = await upload(TOKEN, new File([PNG()], "hall.png", { type: "image/png" }));
    expect(res.status).toBe(200);
    expect(String(db.survey_photos[0].storage_path)).toMatch(/\.png$/);
    expect(objects.get(String(db.survey_photos[0].storage_path))!.contentType).toBe("image/png");
  });

  it("REFUSES a WebP — one stored WebP takes down the whole crew day sheet (B1)", async () => {
    const res = await upload(TOKEN, new File([WEBP()], "lounge.webp", { type: "image/webp" }));
    expect(res.status).toBe(415);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("REFUSES a HEIC, and tells the customer how to send a JPEG instead (B1)", async () => {
    const res = await upload(TOKEN, new File([HEIC()], "IMG_0042.heic", { type: "image/heic" }));
    expect(res.status).toBe(415);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
    // Refusing without saying what to do next sends an iPhone owner to the
    // phone. The copy must name the format AND the fix.
    expect(String(res.body.error)).toMatch(/JPEG/);
    expect(String(res.body.error)).toMatch(/Most Compatible/i);
  });

  it("enforces the size cap", async () => {
    const oversize = new File([new Uint8Array(MAX_IMAGE_UPLOAD_BYTES + 1)], "huge.jpg", {
      type: "image/jpeg",
    });
    const res = await upload(TOKEN, oversize);
    expect(res.status).toBe(413);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("REFUSES a request that declares no Content-Length at all (B2)", async () => {
    // `Number(header ?? "")` is 0 for a missing header — finite and under the
    // cap — so the old guard PASSED exactly the request that had declared
    // nothing, and `request.formData()` then buffered the whole body into the
    // process. A chunked body from this public, session-less endpoint could be
    // any size; there is no reverse-proxy cap in front of it.
    const res = await upload(TOKEN, jpegFile(), {}, null);
    expect(res.status).toBe(411);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("REFUSES an unparseable, empty or negative Content-Length (B2)", async () => {
    for (const declared of ["", "   ", "nope", "-1", "0", "1.5", "NaN"]) {
      const res = await upload(TOKEN, jpegFile(), {}, declared);
      expect(res.status, `content-length: ${JSON.stringify(declared)}`).toBe(411);
    }
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("refuses on the DECLARED size before reading the body", async () => {
    const res = await upload(TOKEN, jpegFile(), {}, String(MAX_IMAGE_UPLOAD_BYTES * 4));
    expect(res.status).toBe(413);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("refuses an empty file, and says empty rather than 'too large'", async () => {
    const res = await upload(TOKEN, new File([new Uint8Array(0)], "empty.jpg", { type: "image/jpeg" }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/empty/i);
    expect(objects.size).toBe(0);
    expect(db.survey_photos).toHaveLength(0);
  });

  const seedFullSurvey = () => {
    db.survey_photos = Array.from({ length: MAX_CUSTOMER_SURVEY_PHOTOS }, (_, i) => ({
      id: `seed-${i}`,
      survey_id: SURVEY_ROW,
      category: "cubic",
      uploaded_by: null,
      customer_uploaded: true,
      storage_path: `${SURVEY_ROW}/cubic/seed-${i}.jpg`,
      created_at: "2026-01-01T00:00:00Z",
    }));
  };

  it("enforces the per-survey count cap", async () => {
    seedFullSurvey();
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(409);
    expect(db.survey_photos).toHaveLength(MAX_CUSTOMER_SURVEY_PHOTOS);
    expect(objects.size).toBe(0);
  });

  it("the ceiling is held by the DATABASE, not by the JS pre-count (B3)", async () => {
    // The pre-count is blinded to 0, which is precisely what a race looks like
    // from the route's point of view: it reads "room for more" and proceeds.
    // The old code inserted at that point. The only thing that can refuse here
    // is `add_customer_survey_photo` itself.
    seedFullSurvey();
    blindPreCount = true;

    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(409);
    expect(db.survey_photos).toHaveLength(MAX_CUSTOMER_SURVEY_PHOTOS);
    // And the object written on the way to the refusal is not left behind.
    expect(objects.size).toBe(0);
  });

  it("concurrent uploads cannot exceed the ceiling between them (B3)", async () => {
    db.survey_photos = Array.from({ length: MAX_CUSTOMER_SURVEY_PHOTOS - 1 }, (_, i) => ({
      id: `seed-${i}`,
      survey_id: SURVEY_ROW,
      category: "cubic",
      uploaded_by: null,
      customer_uploaded: true,
      storage_path: `${SURVEY_ROW}/cubic/seed-${i}.jpg`,
      created_at: "2026-01-01T00:00:00Z",
    }));
    blindPreCount = true; // every request believes the survey is empty

    const results = await Promise.all([
      upload(TOKEN, jpegFile("a.jpg")),
      upload(TOKEN, jpegFile("b.jpg")),
      upload(TOKEN, jpegFile("c.jpg")),
      upload(TOKEN, jpegFile("d.jpg")),
    ]);

    expect(db.survey_photos).toHaveLength(MAX_CUSTOMER_SURVEY_PHOTOS);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    // One row, one object — the three refusals cleaned up after themselves.
    expect(objects.size).toBe(1);
  });

  it("REFUSES when the count cannot be read — a failed read is not 'zero so far'", async () => {
    selectErrors.survey_photos = "connection reset";
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(503);
    expect(objects.size).toBe(0);
  });

  it("ignores any survey id, lead id or path the client tries to supply", async () => {
    const res = await upload(TOKEN, jpegFile("../../escape.jpg"), {
      surveyId: OTHER_SURVEY_ROW,
      leadId: OTHER_LEAD,
      path: `${OTHER_SURVEY_ROW}/cubic/attacker.jpg`,
      category: "access",
    });
    expect(res.status).toBe(200);
    const row = db.survey_photos[0];
    expect(row.survey_id).toBe(SURVEY_ROW);
    expect(row.category).toBe("cubic");
    expect(String(row.storage_path)).toContain(`${SURVEY_ROW}/cubic/`);
    expect(String(row.storage_path)).not.toContain("escape");
    expect(String(row.storage_path)).not.toContain("attacker");
  });

  it("creates the surveys row lazily when the lead has none, and reuses it after", async () => {
    db.surveys = db.surveys.filter((row) => row.lead_id !== LEAD);
    const first = await upload(TOKEN, jpegFile());
    expect(first.status).toBe(200);
    expect(db.surveys.filter((row) => row.lead_id === LEAD)).toHaveLength(1);

    const second = await upload(TOKEN, jpegFile());
    expect(second.status).toBe(200);
    expect(db.surveys.filter((row) => row.lead_id === LEAD)).toHaveLength(1);
    expect(new Set(db.survey_photos.map((row) => row.survey_id)).size).toBe(1);
  });

  it("concurrent FIRST uploads create ONE surveys row, not one each (C1)", async () => {
    // The real shape: the customer opens their link on a phone and a laptop, or
    // retries a slow request, before any survey row exists. The route used to
    // read "no row" in both requests and insert in both — and since every reader
    // on both sides takes only the lead's NEWEST survey, whichever photo landed
    // on the loser was invisible to the customer and the office forever.
    db.surveys = db.surveys.filter((row) => row.lead_id !== LEAD);

    const results = await Promise.all([
      upload(TOKEN, jpegFile("a.jpg")),
      upload(TOKEN, jpegFile("b.jpg")),
      upload(TOKEN, jpegFile("c.jpg")),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.surveys.filter((row) => row.lead_id === LEAD)).toHaveLength(1);
    // And all three photos hang off that one row, so all three are readable.
    expect(db.survey_photos).toHaveLength(3);
    expect(new Set(db.survey_photos.map((row) => row.survey_id)).size).toBe(1);
  });

  it("refuses when the surveys row can neither be found nor created", async () => {
    selectErrors.surveys = "connection reset";
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(503);
    expect(db.survey_photos).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("notes the FIRST photo on the lead's timeline and only the first", async () => {
    await upload(TOKEN, jpegFile());
    await upload(TOKEN, jpegFile());
    expect(db.activities).toHaveLength(1);
    expect(db.activities[0].lead_id).toBe(LEAD);
  });

  it("does NOT re-note when the customer deletes a photo and uploads again (C2)", async () => {
    // A customer retaking one blurry shot is the ordinary case, and `is_first`
    // used to be `count == 0` — which a hard delete puts straight back to 0. Five
    // retakes wrote five identical timeline rows, and a token holder could loop
    // it on purpose. The marker is now a stamp on the survey, so it survives the
    // deletion of every photo that caused it.
    await upload(TOKEN, jpegFile("first.jpg"));
    expect(db.activities).toHaveLength(1);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const photoId = String(db.survey_photos[0].id);
      expect((await deleteCubicCustomerPhotoAction(TOKEN, photoId)).ok).toBe(true);
      expect(db.survey_photos).toHaveLength(0);
      expect((await upload(TOKEN, jpegFile(`retake-${cycle}.jpg`))).status).toBe(200);
    }

    expect(db.survey_photos).toHaveLength(1);
    expect(db.activities).toHaveLength(1);
  });

  it("refuses a FULL survey WITHOUT reading the request body (C3)", async () => {
    // ~30 MB buffered into a live process per request, on a public session-less
    // route that could never have stored anything. The count needs only the
    // token and the survey row, both resolved before the body is touched.
    seedFullSurvey();

    const form = new FormData();
    form.append("file", jpegFile());
    const request = await multipartRequest(`http://ops.test/cv/${TOKEN}/photos`, form);
    let bodyReads = 0;
    Object.defineProperty(request, "formData", {
      value: async () => {
        bodyReads += 1;
        throw new Error("the body must not be read on a full survey");
      },
    });

    const response = await POST(request, { params: Promise.resolve({ token: TOKEN }) });
    // 409, not the 400 the route returns when formData throws — which is what
    // makes this a discriminating test rather than a restatement of the cap.
    expect(response.status).toBe(409);
    expect(bodyReads).toBe(0);
    expect(db.survey_photos).toHaveLength(MAX_CUSTOMER_SURVEY_PHOTOS);
    expect(objects.size).toBe(0);
  });

  it("writes the timeline note EXACTLY ONCE when photos arrive together (B3)", async () => {
    // Every request's own pre-read says "nothing here yet", which is what a
    // multi-select on a phone genuinely looks like. The old `if (existing === 0)`
    // guard wrote one duplicate activity row per racing request — precisely the
    // amplification its own comment promised to prevent. `is_first` now comes
    // back from inside the same indivisible step as the insert.
    blindPreCount = true;
    await Promise.all([
      upload(TOKEN, jpegFile("a.jpg")),
      upload(TOKEN, jpegFile("b.jpg")),
      upload(TOKEN, jpegFile("c.jpg")),
      upload(TOKEN, jpegFile("d.jpg")),
      upload(TOKEN, jpegFile("e.jpg")),
    ]);
    expect(db.survey_photos).toHaveLength(5);
    expect(db.activities).toHaveLength(1);
  });

  it("reports `remaining` from the database's count, not from its own read", async () => {
    db.survey_photos = Array.from({ length: 3 }, (_, i) => ({
      id: `seed-${i}`,
      survey_id: SURVEY_ROW,
      category: "cubic",
      uploaded_by: null,
      customer_uploaded: true,
      storage_path: `${SURVEY_ROW}/cubic/seed-${i}.jpg`,
      created_at: "2026-01-01T00:00:00Z",
    }));
    blindPreCount = true; // the route's own read would have said 0, so 19 left
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(MAX_CUSTOMER_SURVEY_PHOTOS - 4);
  });

  it("leaves no orphan object when the row write fails", async () => {
    writeErrors.survey_photos = "insert failed";
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(503);
    expect(objects.size).toBe(0);
    expect(db.survey_photos).toHaveLength(0);
  });

  it("records nothing when the bucket write fails", async () => {
    storeThrows = true;
    const res = await upload(TOKEN, jpegFile());
    expect(res.status).toBe(503);
    expect(db.survey_photos).toHaveLength(0);
  });

  it("never writes the share token into a log line", async () => {
    storeThrows = true;
    await upload(TOKEN, jpegFile());
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});

describe("deleteCubicCustomerPhotoAction", () => {
  beforeEach(() => {
    reset();
    db.survey_photos = [
      {
        id: PHOTO_ID,
        survey_id: SURVEY_ROW,
        category: "cubic",
        uploaded_by: null,
        customer_uploaded: true,
        storage_path: `${SURVEY_ROW}/cubic/mine.jpg`,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
        survey_id: SURVEY_ROW,
        category: "cubic",
        uploaded_by: "office-1",
        customer_uploaded: false,
        storage_path: `${SURVEY_ROW}/cubic/office.jpg`,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
        survey_id: OTHER_SURVEY_ROW,
        category: "cubic",
        uploaded_by: null,
        customer_uploaded: true,
        storage_path: `${OTHER_SURVEY_ROW}/cubic/stranger.jpg`,
        created_at: "2026-01-01T00:00:00Z",
      },
      // An OFFICE photo from before migration 0117 that happens to carry a null
      // uploader. `uploaded_by is null` alone would have let a share token
      // delete an estimator's photo of the inside of someone's house;
      // `customer_uploaded` is the clause that actually holds here.
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
        survey_id: SURVEY_ROW,
        category: "cubic",
        uploaded_by: null,
        customer_uploaded: false,
        storage_path: `${SURVEY_ROW}/cubic/legacy-office.jpg`,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    for (const row of db.survey_photos) {
      objects.set(String(row.storage_path), { bytes: 64, contentType: "image/jpeg" });
    }
  });

  it("removes the customer's own photo, row and object together", async () => {
    const res = await deleteCubicCustomerPhotoAction(TOKEN, PHOTO_ID);
    expect(res.ok).toBe(true);
    expect(db.survey_photos.some((row) => row.id === PHOTO_ID)).toBe(false);
    expect(objects.has(`${SURVEY_ROW}/cubic/mine.jpg`)).toBe(false);
  });

  it("refuses an OFFICE photo on the same survey — a token cannot delete the estimator's evidence", async () => {
    const res = await deleteCubicCustomerPhotoAction(TOKEN, "dddddddd-dddd-4ddd-8ddd-ddddddddddd2");
    expect(res.ok).toBe(false);
    expect(db.survey_photos).toHaveLength(4);
    expect(objects.has(`${SURVEY_ROW}/cubic/office.jpg`)).toBe(true);
  });

  it("refuses a PRE-0117 office photo whose uploader is null", async () => {
    const res = await deleteCubicCustomerPhotoAction(TOKEN, "dddddddd-dddd-4ddd-8ddd-ddddddddddd4");
    expect(res.ok).toBe(false);
    expect(db.survey_photos).toHaveLength(4);
    expect(objects.has(`${SURVEY_ROW}/cubic/legacy-office.jpg`)).toBe(true);
  });

  it("refuses another survey's photo", async () => {
    const res = await deleteCubicCustomerPhotoAction(TOKEN, "dddddddd-dddd-4ddd-8ddd-ddddddddddd3");
    expect(res.ok).toBe(false);
    expect(objects.has(`${OTHER_SURVEY_ROW}/cubic/stranger.jpg`)).toBe(true);
  });

  it("refuses a bad token and a non-uuid id", async () => {
    expect((await deleteCubicCustomerPhotoAction("nope", PHOTO_ID)).ok).toBe(false);
    expect((await deleteCubicCustomerPhotoAction(TOKEN, "'; drop table survey_photos; --")).ok).toBe(false);
    expect(db.survey_photos).toHaveLength(4);
  });

  it("refuses when the survey is finalised", async () => {
    db.cubic_surveys[0].status = "complete";
    const res = await deleteCubicCustomerPhotoAction(TOKEN, PHOTO_ID);
    expect(res.ok).toBe(false);
    expect(db.survey_photos).toHaveLength(4);
  });
});
