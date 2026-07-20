"use client";

/**
 * Offline outbox provider (crew-reliability PRD A3). Owns the IndexedDB queue
 * and the flush lifecycle, and exposes it to the crew UI via useOutbox().
 *
 * Flush triggers: on mount, when the connection returns (`online` event), when
 * the app comes back to the foreground (the main path for an installed PWA),
 * every 30s while open, and immediately after an enqueue. A single-flight lock
 * (flushingRef) means two triggers firing together can't double-submit — the
 * second guarantee (idempotent server actions) covers the rest.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createIndexedDbStore, outboxSupported } from "@/lib/offline/db";
import { enqueue as enqueueCore, flushOutbox, type OutboxItem, type OutboxKind, type OutboxStore } from "@/lib/offline/outbox";
import { outboxRunners } from "./runners";

interface EnqueueInput {
  kind: OutboxKind;
  key: string;
  payload: unknown;
  label: string;
}

interface OutboxApi {
  items: OutboxItem[];
  syncing: boolean;
  online: boolean;
  /** Persist an item; throws if the device can't store one (caller must surface). */
  enqueue: (input: EnqueueInput) => Promise<OutboxItem>;
  /** Drain the queue now (used by the "retry" affordance). */
  flush: () => Promise<void>;
}

const OutboxContext = createContext<OutboxApi | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const storeRef = useRef<OutboxStore | null>(null);
  const flushingRef = useRef(false);
  const router = useRouter();

  const store = useCallback((): OutboxStore => {
    if (!storeRef.current) storeRef.current = createIndexedDbStore();
    return storeRef.current;
  }, []);

  const reload = useCallback(async () => {
    try {
      setItems(await store().all());
    } catch {
      // A read failure must never blank the UI silently — keep the last known set.
    }
  }, [store]);

  const flush = useCallback(async () => {
    if (flushingRef.current) return; // single-flight
    if (typeof navigator !== "undefined" && !navigator.onLine) return; // nothing to gain offline
    flushingRef.current = true;
    setSyncing(true);
    try {
      const summary = await flushOutbox(store(), outboxRunners);
      await reload();
      // Something synced in the background (e.g. an offline completion landed) —
      // refresh so the current page reflects the new server state.
      if (summary.synced > 0) router.refresh();
    } catch {
      // swallow — items stay queued and the next trigger retries
    } finally {
      flushingRef.current = false;
      setSyncing(false);
    }
  }, [store, reload, router]);

  const enqueue = useCallback(
    async (input: EnqueueInput) => {
      if (!outboxSupported()) throw new Error("This device can't save changes offline.");
      const item = await enqueueCore(store(), {
        id: crypto.randomUUID(),
        now: Date.now(),
        kind: input.kind,
        key: input.key,
        payload: input.payload,
        label: input.label,
      });
      await reload();
      void flush(); // if we're online, go straight away
      return item;
    },
    [store, reload, flush],
  );

  useEffect(() => {
    if (!outboxSupported()) return;
    setOnline(navigator.onLine);
    void reload().then(() => void flush());

    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setOnline(navigator.onLine);
        void flush();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => void flush(), 30_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [reload, flush]);

  return (
    <OutboxContext.Provider value={{ items, syncing, online, enqueue, flush }}>{children}</OutboxContext.Provider>
  );
}

export function useOutbox(): OutboxApi {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error("useOutbox must be used inside <OutboxProvider>");
  return ctx;
}
