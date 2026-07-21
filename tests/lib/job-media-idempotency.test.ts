import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A4 idempotency proof for crew media capture. The crew's tray is the ONLY copy
 * of a capture until it's filed; on rural signal the record call can succeed but
 * the response drop, and the crew re-taps "File". recordJobMediaAction must
 * treat that retry as a graceful no-op (storage_path is the natural key), never
 * a "Could not save" error and never a duplicate row.
 */

// Stateful fake DB shared by the mocks.
const store = {
  media: new Set<string>(), // storage_paths already filed
  activities: 0,
};

const LEAD = "11111111-1111-4111-8111-111111111111";
// A direct lead anchor is an office-only capture surface. Crew capture is
// appointment-anchored and assignment-gated before this idempotency layer.
const profile = { id: "p1", active: true, role: "admin", full_name: "Office Test" };

function chain(handlers: Record<string, unknown>) {
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of ["select", "eq", "in", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: handlers.single ?? null });
  q.single = async () => ({ data: handlers.single ?? null });
  q.then = (resolve: (v: unknown) => void) => resolve({ data: handlers.rows ?? [] });
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "p1" } } }) },
    from: () => chain({ single: profile }),
  }),
}));

vi.mock("@/lib/storage/media-store", () => ({
  createMediaStore: () => ({ getObjectMetadata: async () => ({ size: 1 }) }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "leads") return chain({ single: { id: LEAD, name: "Jane", client_id: null, media_consent: "granted" } });
      if (table === "staff") return chain({ single: { full_name: "Rob Pierce" } });
      if (table === "activities") return { insert: async () => ((store.activities += 1), { error: null }) };
      if (table === "job_media") {
        return {
          upsert: (rows: { storage_path: string }[]) => ({
            // ON CONFLICT DO NOTHING: only rows whose path is new insert + return.
            select: async () => {
              const fresh = rows.filter((r) => !store.media.has(r.storage_path));
              fresh.forEach((r) => store.media.add(r.storage_path));
              return { data: fresh.map((r) => ({ storage_path: r.storage_path })), error: null };
            },
          }),
        };
      }
      return chain({});
    },
  }),
}));

import { recordJobMediaAction } from "@/app/actions/job-media";

const path = (n: number) => `${LEAD}/2222222${n}-2222-4222-8222-222222222222.jpg`;
const item = (n: number) => ({ kind: "photo" as const, path: path(n), mime: "image/jpeg", bytes: 1000, durationS: null, caption: "", tag: "before" as const });

describe("recordJobMediaAction — idempotent on retry", () => {
  beforeEach(() => {
    store.media.clear();
    store.activities = 0;
  });

  it("first save files every item once", async () => {
    const res = await recordJobMediaAction({ leadId: LEAD }, [item(1), item(2)]);
    expect(res).toEqual({ ok: true, count: 2 });
    expect(store.media.size).toBe(2);
  });

  it("a full retry is a graceful no-op — no error, no duplicate, count 0", async () => {
    await recordJobMediaAction({ leadId: LEAD }, [item(1), item(2)]);
    const retry = await recordJobMediaAction({ leadId: LEAD }, [item(1), item(2)]);
    expect(retry).toEqual({ ok: true, count: 0 }); // 0 new
    expect(store.media.size).toBe(2); // still just two rows
    expect(store.activities).toBe(1); // first save logged once; the retry adds no second line
  });

  it("a partial retry files only the genuinely new item", async () => {
    await recordJobMediaAction({ leadId: LEAD }, [item(1)]); // first save (1 item dropped its ack)
    const res = await recordJobMediaAction({ leadId: LEAD }, [item(1), item(2)]); // retry adds item 2
    expect(res).toEqual({ ok: true, count: 1 });
    expect(store.media.size).toBe(2);
  });
});
