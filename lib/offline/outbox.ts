/**
 * Offline write queue (crew-reliability PRD A3). Crew actions taken with no
 * signal are persisted to an on-device outbox and replayed when the connection
 * returns — nothing a crew member does in a dead spot is ever silently lost.
 *
 * Exactly-once is a TWO-layer guarantee:
 *  1. this queue is single-flight (the provider holds a flush lock) and removes
 *     an item only after the server confirms it, and
 *  2. every server action a runner calls is idempotent on a natural key
 *     (job completion → appointment_id, media → storage_path, …), so even a
 *     double-submit collapses to one record server-side.
 *
 * This module is the PURE core (types + the flush algorithm) so it can be
 * unit-tested with an in-memory store; the IndexedDB store (lib/offline/db.ts)
 * and the React flush manager (components/offline/outbox-provider.tsx) are thin
 * shells around it.
 */

/** Give up auto-retrying after this many attempts, but NEVER drop the item —
 *  it flips to 'failed' and stays visible so the crew (and office) can act. */
export const MAX_OUTBOX_ATTEMPTS = 8;

export type OutboxKind = "job_completion";

export interface OutboxItem<P = unknown> {
  /** Client-generated unique id (dedupe within the queue / stable React key). */
  id: string;
  kind: OutboxKind;
  /** Idempotency/dedupe key — one PENDING item per (kind, key). For a job
   *  completion this is the appointment id, so re-saving replaces the queued
   *  copy rather than stacking a second. */
  key: string;
  payload: P;
  status: "queued" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: number;
  /** A human label for the sync UI ("Completion for Jane Doe"). */
  label: string;
}

export type RunnerResult =
  | { outcome: "done" } // server accepted (incl. "already applied") → drop from queue
  | { outcome: "retry"; error: string } // transient (offline / 5xx) → keep + retry
  | { outcome: "failed"; error: string }; // permanent (validation) → keep, mark failed, surface

export type Runner = (payload: unknown) => Promise<RunnerResult>;
export type RunnerMap = Partial<Record<OutboxKind, Runner>>;

/** Minimal persistence surface the flush core needs — IndexedDB is one impl. */
export interface OutboxStore {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface FlushSummary {
  attempted: number;
  synced: number;
  retried: number;
  failed: number;
}

/** True while there is anything the crew still needs synced (queued or failed). */
export function pendingCount(items: OutboxItem[]): number {
  return items.filter((i) => i.status === "queued" || i.status === "failed").length;
}

/**
 * Drain the outbox once. Processes only 'queued' items, oldest first, one at a
 * time (a runner that throws is treated as a transient retry, never a crash).
 * An item is removed ONLY on a confirmed 'done'; on 'retry' it stays queued
 * until the attempt cap, then flips to 'failed' (never dropped).
 */
export async function flushOutbox(store: OutboxStore, runners: RunnerMap): Promise<FlushSummary> {
  const summary: FlushSummary = { attempted: 0, synced: 0, retried: 0, failed: 0 };
  const queued = (await store.all())
    .filter((i) => i.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const item of queued) {
    const runner = runners[item.kind];
    if (!runner) continue; // unknown kind (older build) — leave it for a build that knows it

    summary.attempted++;
    let res: RunnerResult;
    try {
      res = await runner(item.payload);
    } catch (e) {
      res = { outcome: "retry", error: e instanceof Error ? e.message : "sync failed" };
    }

    if (res.outcome === "done") {
      await store.remove(item.id);
      summary.synced++;
      continue;
    }

    const attempts = item.attempts + 1;
    if (res.outcome === "failed") {
      await store.put({ ...item, status: "failed", attempts, lastError: res.error });
      summary.failed++;
      continue;
    }

    // retry
    const capped = attempts >= MAX_OUTBOX_ATTEMPTS;
    await store.put({ ...item, status: capped ? "failed" : "queued", attempts, lastError: res.error });
    if (capped) summary.failed++;
    else summary.retried++;
  }

  return summary;
}

/**
 * Enqueue an item, collapsing to one PENDING item per (kind, key): a re-save of
 * the same completion replaces the queued copy (and resets a 'failed' one back
 * to 'queued' for another go) instead of stacking duplicates.
 */
export async function enqueue(
  store: OutboxStore,
  input: { id: string; kind: OutboxKind; key: string; payload: unknown; label: string; now: number },
): Promise<OutboxItem> {
  const existing = (await store.all()).find((i) => i.kind === input.kind && i.key === input.key);
  const item: OutboxItem = {
    id: existing?.id ?? input.id,
    kind: input.kind,
    key: input.key,
    payload: input.payload,
    status: "queued",
    attempts: 0,
    createdAt: existing?.createdAt ?? input.now,
    label: input.label,
  };
  await store.put(item);
  return item;
}
