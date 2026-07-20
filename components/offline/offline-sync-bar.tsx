"use client";

/**
 * The crew's single, persistent connection + sync status bar (crew-reliability
 * PRD A2 offline indicator + A3 "show queued-item count and sync status").
 * Fixed to the bottom so it never fights the sticky header. One surface, five
 * states, so a crew member always knows whether what they did is safe:
 *   - failed items      → red, "N couldn't sync — tap to retry"
 *   - offline + queued  → amber, "Offline — N change(s) will sync when you're back"
 *   - offline + clear   → amber, "You're offline — showing your saved jobs"
 *   - online + syncing  → teal, "Syncing N change(s)…"
 *   - online + clear    → hidden
 */

import { CloudOff, RefreshCw, UploadCloud, WifiOff, CheckCircle2 } from "lucide-react";
import { useOutbox } from "./outbox-provider";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function OfflineSyncBar() {
  const { items, syncing, online, flush } = useOutbox();
  const queued = items.filter((i) => i.status === "queued").length;
  const failed = items.filter((i) => i.status === "failed").length;

  const base =
    "fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-2 border-t px-4 py-2.5 text-sm font-semibold shadow-[0_-1px_6px_rgba(0,0,0,0.08)]";
  const safeArea = { paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" };

  // 1. Failed — the loudest state. Never auto-hidden; tap to retry.
  if (failed > 0) {
    return (
      <button
        type="button"
        onClick={() => void flush()}
        role="status"
        className={`${base} border-danger/40 bg-danger/10 text-danger`}
        style={safeArea}
      >
        <CloudOff className="size-4 shrink-0" strokeWidth={2} />
        {plural(failed, "change")} couldn&apos;t sync — tap to retry, or call the office
      </button>
    );
  }

  // 2/3. Offline.
  if (!online) {
    return (
      <div role="status" aria-live="polite" className={`${base} border-amber-300 bg-amber-100 text-amber-900`} style={safeArea}>
        <WifiOff className="size-4 shrink-0" strokeWidth={2} />
        {queued > 0 ? `Offline — ${plural(queued, "change")} will sync when you're back` : "You're offline — showing your saved jobs"}
      </div>
    );
  }

  // 4. Online + syncing/queued.
  if (queued > 0 || syncing) {
    return (
      <div role="status" aria-live="polite" className={`${base} border-teal-300 bg-teal-100 text-teal-900`} style={safeArea}>
        {syncing ? <UploadCloud className="size-4 shrink-0 animate-pulse" strokeWidth={2} /> : <RefreshCw className="size-4 shrink-0" strokeWidth={2} />}
        {syncing ? `Syncing ${plural(queued || 1, "change")}…` : `${plural(queued, "change")} waiting to sync`}
      </div>
    );
  }

  // 5. Online + nothing pending → nothing to show. (A brief "all synced" is
  // handled by the toast on the action itself.)
  return null;
}

/** Small inline badge for a single queued/failed action (used on the job page
 *  next to a completed-but-unsynced job). */
export function PendingSyncBadge({ state }: { state: "queued" | "failed" }) {
  return state === "failed" ? (
    <span className="inline-flex items-center gap-1 rounded-pill bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
      <CloudOff className="size-3" strokeWidth={2} /> Couldn&apos;t sync
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-pill bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-800">
      <CheckCircle2 className="size-3" strokeWidth={2} /> Saved — waiting to sync
    </span>
  );
}
