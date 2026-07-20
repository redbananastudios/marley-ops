"use client";

/**
 * IndexedDB-backed OutboxStore. Deliberately dependency-free (raw IndexedDB
 * behind small promise wrappers) — one object store, keyed by item id.
 *
 * IndexedDB (not localStorage) because a queued job completion carries a
 * base64 certificate PDF that can run to hundreds of KB, past localStorage's
 * ~5MB string budget and its synchronous, main-thread cost.
 *
 * Chosen over the Background Sync API because the crew are on iPhones and iOS
 * Safari doesn't implement Background Sync — the provider flushes in-page on
 * reconnect/foreground instead, which works everywhere.
 */

import type { OutboxItem, OutboxStore } from "./outbox";

const DB_NAME = "marley-outbox";
const STORE = "outbox";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result as T);
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** True when this environment can persist an outbox at all (private-mode Safari
 *  and some embedded webviews block IndexedDB — the caller must fail loudly
 *  rather than pretend a write was saved). */
export function outboxSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export function createIndexedDbStore(): OutboxStore {
  return {
    async all() {
      const db = await openDb();
      try {
        return await tx<OutboxItem[]>(db, "readonly", (s) => s.getAll() as IDBRequest<OutboxItem[]>);
      } finally {
        db.close();
      }
    },
    async put(item) {
      const db = await openDb();
      try {
        await tx(db, "readwrite", (s) => s.put(item));
      } finally {
        db.close();
      }
    },
    async remove(id) {
      const db = await openDb();
      try {
        await tx(db, "readwrite", (s) => s.delete(id));
      } finally {
        db.close();
      }
    },
  };
}
