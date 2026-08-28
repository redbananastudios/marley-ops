import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level contract for the multi-brand ingest (multi-brand PRD §3.8).
 *
 * One route serves every brand's website, and WHICH brand a lead lands under
 * derives from which bearer secret matched — never from the payload. These
 * tests pin the whole POST handler end to end (storage mocked at the one
 * seam, `landWebsiteLead`) because the property that matters is a route
 * property: the brand the storage layer receives, and the fact that a body
 * claiming a brand its secret cannot vouch for gets the SAME uninformative
 * 401 as a bad secret. Marley's live site keeps posting with the original
 * `LEAD_INGEST_SECRET` and must see identical behaviour throughout.
 */

const { landWebsiteLead, brandsLookup } = vi.hoisted(() => ({
  landWebsiteLead: vi.fn(),
  /** What the brands allowlist read answers. Default: the slug exists. */
  brandsLookup: {
    row: { slug: "" } as { slug: string } | null,
    error: null as { message: string } | null,
  },
}));

vi.mock("@/lib/leads/website-lead", () => ({ landWebsiteLead }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, slug: string) => ({
          maybeSingle: async () => ({
            data: brandsLookup.error
              ? null
              : brandsLookup.row === null
                ? null
                : { slug: brandsLookup.row.slug || slug },
            error: brandsLookup.error,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorContext: (err: unknown) => ({ error: String(err) }),
}));

import { POST } from "@/app/api/ingest/lead/route";

const SECRET_MARLEY = "marley-secret-long-enough";
const SECRET_PITMANS = "pitmans-secret-long-enough";

const enquiry = { leadId: "wp-0000001234", name: "Paul Betty", phone: "07700 900123" };

function post(body: Record<string, unknown>, token: string | null) {
  return POST(
    new Request("http://ops.test/api/ingest/lead", {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  brandsLookup.row = { slug: "" };
  brandsLookup.error = null;
  vi.stubEnv("LEAD_INGEST_SECRET", SECRET_MARLEY);
  vi.stubEnv("LEAD_INGEST_SECRET_PITMANS", SECRET_PITMANS);
  landWebsiteLead.mockResolvedValue({ leadId: "L1", created: true, alertSubmittedAt: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/ingest/lead — brand from the secret", () => {
  it("the Marley secret lands the lead under marley, exactly as it always has", async () => {
    const res = await post(enquiry, SECRET_MARLEY);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, leadId: "L1", created: true });
    expect(landWebsiteLead).toHaveBeenCalledTimes(1);
    expect(landWebsiteLead.mock.calls[0][1]).toMatchObject({
      brand: "marley",
      externalLeadId: "wp-0000001234",
    });
  });

  it("the Pitmans secret lands the SAME external id under pitmans", async () => {
    const res = await post(enquiry, SECRET_PITMANS);
    expect(res.status).toBe(201);
    expect(landWebsiteLead.mock.calls[0][1]).toMatchObject({
      brand: "pitmans",
      externalLeadId: "wp-0000001234",
    });
  });

  it("accepts a payload brand that agrees with the secret's", async () => {
    const res = await post({ ...enquiry, brand: "pitmans" }, SECRET_PITMANS);
    expect(res.status).toBe(201);
    expect(landWebsiteLead.mock.calls[0][1]).toMatchObject({ brand: "pitmans" });
  });

  it("refuses a payload brand the secret cannot vouch for — same response as a bad secret", async () => {
    const res = await post({ ...enquiry, brand: "marley" }, SECRET_PITMANS);
    expect(res.status).toBe(401);
    // Uninformative on purpose: no `detail`, nothing distinguishing this from
    // a wrong secret — the caller learns nothing about what is configured.
    await expect(res.json()).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/lead — fail closed", () => {
  it("a wrong secret is refused", async () => {
    const res = await post(enquiry, "wrong-secret-but-long-enough");
    expect(res.status).toBe(401);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });

  it("an unconfigured per-brand secret never matches", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET_PITMANS", "");
    const res = await post(enquiry, SECRET_PITMANS);
    expect(res.status).toBe(401);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });

  it("with NO secrets configured every request is refused — Marley behaviour unchanged", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    vi.stubEnv("LEAD_INGEST_SECRET_PITMANS", "");
    expect((await post(enquiry, SECRET_MARLEY)).status).toBe(401);
    expect((await post(enquiry, null)).status).toBe(401);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });
});

/**
 * Credential hygiene at the route (QA-20260826-09). Both holes here failed
 * OPEN and silent, while every other misconfiguration on this path fails closed
 * and loud — and the consequence of the first is a wrong-brand financial
 * document reaching a real customer.
 */
describe("POST /api/ingest/lead — a credential must name exactly one real brand", () => {
  beforeEach(() => {
    brandsLookup.row = { slug: "" };
    brandsLookup.error = null;
    landWebsiteLead.mockReset();
    landWebsiteLead.mockResolvedValue({ leadId: "lead-1", created: true, alertSubmittedAt: null });
  });

  it("a secret whose suffix names no brands row is a 401, not a 5xx from the foreign key", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET_MARLEY);
    vi.stubEnv("LEAD_INGEST_SECRET_PITMANS_OLD", "rotated-out-but-long-enough");
    brandsLookup.row = null; // no such slug
    const res = await post(enquiry, "rotated-out-but-long-enough");
    expect(res.status).toBe(401);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });

  it("an unreadable brands table is a 500, never a 401 - 'I could not check' is not 'no such brand'", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET_MARLEY);
    brandsLookup.error = { message: "connection terminated" };
    const res = await post(enquiry, SECRET_MARLEY);
    // A real enquiry must get the answer that says 'retry', not the one that
    // says 'you are not welcome'.
    expect(res.status).toBe(500);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });

  it("the group pseudo-brand cannot hold an ingest credential", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET_MARLEY);
    vi.stubEnv("LEAD_INGEST_SECRET_GROUP", "group-secret-long-enough");
    const res = await post(enquiry, "group-secret-long-enough");
    expect(res.status).toBe(401);
    expect(landWebsiteLead).not.toHaveBeenCalled();
  });
});
