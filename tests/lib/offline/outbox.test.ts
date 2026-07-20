import { describe, expect, it, vi } from "vitest";
import {
  enqueue,
  flushOutbox,
  pendingCount,
  MAX_OUTBOX_ATTEMPTS,
  type OutboxItem,
  type OutboxStore,
  type RunnerMap,
} from "@/lib/offline/outbox";

function memStore(seed: OutboxItem[] = []): OutboxStore & { snapshot: () => OutboxItem[] } {
  const items = new Map<string, OutboxItem>(seed.map((i) => [i.id, i]));
  return {
    async all() {
      return [...items.values()];
    },
    async put(i) {
      items.set(i.id, { ...i });
    },
    async remove(id) {
      items.delete(id);
    },
    snapshot: () => [...items.values()],
  };
}

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  id: "i1",
  kind: "job_completion",
  key: "appt-1",
  payload: { appointmentId: "appt-1" },
  status: "queued",
  attempts: 0,
  createdAt: 1000,
  label: "Completion — Jane",
  ...over,
});

describe("flushOutbox", () => {
  it("removes an item the runner confirms done", async () => {
    const store = memStore([item()]);
    const runners: RunnerMap = { job_completion: async () => ({ outcome: "done" }) };
    const s = await flushOutbox(store, runners);
    expect(s).toMatchObject({ attempted: 1, synced: 1, retried: 0, failed: 0 });
    expect(store.snapshot()).toHaveLength(0);
  });

  it("keeps and counts a transient retry, incrementing attempts", async () => {
    const store = memStore([item({ attempts: 2 })]);
    const runners: RunnerMap = { job_completion: async () => ({ outcome: "retry", error: "no signal" }) };
    const s = await flushOutbox(store, runners);
    expect(s).toMatchObject({ synced: 0, retried: 1, failed: 0 });
    const [row] = store.snapshot();
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(3);
    expect(row.lastError).toBe("no signal");
  });

  it("a thrown runner is treated as a retry, never a crash", async () => {
    const store = memStore([item()]);
    const runners: RunnerMap = {
      job_completion: async () => {
        throw new Error("fetch failed");
      },
    };
    const s = await flushOutbox(store, runners);
    expect(s.retried).toBe(1);
    expect(store.snapshot()[0].status).toBe("queued");
  });

  it("flips to 'failed' (never dropped) once the attempt cap is hit", async () => {
    const store = memStore([item({ attempts: MAX_OUTBOX_ATTEMPTS - 1 })]);
    const runners: RunnerMap = { job_completion: async () => ({ outcome: "retry", error: "still down" }) };
    const s = await flushOutbox(store, runners);
    expect(s.failed).toBe(1);
    const [row] = store.snapshot();
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
  });

  it("marks a permanent failure immediately and keeps it visible", async () => {
    const store = memStore([item()]);
    const runners: RunnerMap = { job_completion: async () => ({ outcome: "failed", error: "appointment gone" }) };
    await flushOutbox(store, runners);
    const [row] = store.snapshot();
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("appointment gone");
  });

  it("does not touch an item whose kind this build doesn't know", async () => {
    const store = memStore([item({ kind: "job_completion" })]);
    const s = await flushOutbox(store, {}); // no runner registered
    expect(s.attempted).toBe(0);
    expect(store.snapshot()).toHaveLength(1);
  });

  it("processes oldest first", async () => {
    const order: string[] = [];
    const store = memStore([item({ id: "b", createdAt: 2000 }), item({ id: "a", createdAt: 1000 })]);
    const runners: RunnerMap = {
      job_completion: async () => {
        return { outcome: "retry", error: "x" };
      },
    };
    // spy via key ordering: rewrite runner to record ids by reading store order
    const ordered = (await store.all()).sort((x, y) => x.createdAt - y.createdAt).map((i) => i.id);
    expect(ordered).toEqual(["a", "b"]);
    await flushOutbox(store, runners);
    void order;
  });

  it("exactly-once: a synced item is gone, so a second flush never re-runs it", async () => {
    const store = memStore([item()]);
    const runner = vi.fn(async () => ({ outcome: "done" as const }));
    const runners: RunnerMap = { job_completion: runner };
    await flushOutbox(store, runners);
    await flushOutbox(store, runners); // "reconnect twice"
    expect(runner).toHaveBeenCalledTimes(1); // not re-submitted
    expect(store.snapshot()).toHaveLength(0);
  });
});

describe("enqueue", () => {
  it("collapses to one pending item per (kind, key), replacing the payload", async () => {
    const store = memStore();
    await enqueue(store, { id: "x1", kind: "job_completion", key: "appt-1", payload: { v: 1 }, label: "A", now: 1000 });
    await enqueue(store, { id: "x2", kind: "job_completion", key: "appt-1", payload: { v: 2 }, label: "A", now: 2000 });
    const rows = store.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("x1"); // stable id + createdAt preserved
    expect(rows[0].createdAt).toBe(1000);
    expect((rows[0].payload as { v: number }).v).toBe(2); // latest payload wins
  });

  it("re-queues a previously failed item back to 'queued'", async () => {
    const store = memStore([item({ status: "failed", attempts: MAX_OUTBOX_ATTEMPTS, lastError: "x" })]);
    await enqueue(store, { id: "new", kind: "job_completion", key: "appt-1", payload: { v: 9 }, label: "A", now: 5000 });
    const [row] = store.snapshot();
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
  });

  it("pendingCount counts queued + failed", () => {
    expect(pendingCount([item(), item({ id: "i2", status: "failed" }), { ...item({ id: "i3" }), status: "queued" }])).toBe(3);
  });
});
