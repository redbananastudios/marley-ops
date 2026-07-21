"use client";

/**
 * New-website-lead alarm (Peter, 2026-07-14). Mounted once in the dashboard
 * layout: polls for unacknowledged web leads, sounds a repeating two-tone
 * chime, and shows a persistent top banner until someone hits Acknowledge.
 *
 * The chime is bounded (10 repeats per batch) so it nags without becoming
 * torture; the banner stays put until acked. A poll returning the SAME
 * still-unacked leads must NOT restart the noise — only a lead id we've never
 * chimed for does (see lib/lead-alerts.ts::nextChimeState).
 *
 * Sound uses the Web Audio API (no asset). Browsers block audio until a user
 * gesture, so the banner exposes an explicit Enable sound action when needed.
 * Audio is best-effort: the banner never depends on it and nothing here throws.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ackWebLeadsAction } from "@/app/actions/lead-alerts";
import {
  ALERT_POLL_MS,
  CHIMED_STORAGE_KEY,
  CHIME_MAX_REPEATS,
  CHIME_REPEAT_MS,
  nextChimeState,
  parseChimedLeadIds,
  serializeChimedLeadIds,
  type UnackedWebLead,
} from "@/lib/lead-alerts";
import { ALERT_LEDGER_CACHE, ALERT_MARKER_PATH } from "@/lib/pwa/cache-rules";

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Poll the unacked-lead read over plain fetch, NOT a server action. Server
 * actions share the router's navigation queue, so a mount/focus-time action
 * dispatch can supersede an in-flight redirect (it reproducibly swallowed the
 * post-login / -> /estimator hop). A fetch cannot touch the router.
 */
async function fetchUnackedWebLeads(): Promise<UnackedWebLead[]> {
  const res = await fetch("/api/lead-alerts", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load new-lead alerts.");
  const body = (await res.json()) as { leads?: UnackedWebLead[] };
  return Array.isArray(body.leads) ? body.leads : [];
}

async function readLastOsNotificationAt(): Promise<number | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(ALERT_LEDGER_CACHE);
    const response = await cache.match(ALERT_MARKER_PATH);
    if (!response) return null;
    const value = Number(await response.text());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function resumeAudioContext(ctx: AudioContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.resume(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Audio resume timed out")), 1_500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function NewLeadAlert() {
  const [leads, setLeads] = useState<UnackedWebLead[]>([]);
  const [acking, setAcking] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [soundError, setSoundError] = useState<string | null>(null);

  const chimedRef = useRef<Set<string>>(new Set());
  const unackedRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const chimeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatsRef = useRef(0);
  const pollSequenceRef = useRef(0);
  const claimedAtRef = useRef(0);
  const latestLeadIdsRef = useRef<string[]>([]);

  // --- audio (best-effort, never throws) -----------------------------------
  const ensureCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    if (typeof window === "undefined") return null;
    const Ctor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctxRef.current = new Ctor();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  const playTone = useCallback((ctx: AudioContext) => {
    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.connect(gain);
      // Two-tone rise 880 -> 1320Hz, ~0.4s, quick decay on each tone.
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.2);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      gain.gain.setValueAtTime(0.0001, now + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.25, now + 0.22);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.42);
    } catch {
      /* audio unavailable — stay silent */
    }
  }, []);

  const chime = useCallback((): boolean => {
    const ctx = ensureCtx();
    if (!ctx || ctx.state !== "running") {
      setSoundBlocked(true);
      return false;
    }
    setSoundBlocked(false);
    playTone(ctx);
    return true;
  }, [ensureCtx, playTone]);

  const stopChimeCycle = useCallback(() => {
    if (chimeTimerRef.current !== null) {
      clearInterval(chimeTimerRef.current);
      chimeTimerRef.current = null;
    }
    repeatsRef.current = 0;
  }, []);

  const startChimeCycle = useCallback((): boolean => {
    stopChimeCycle();
    if (!chime()) return false;
    repeatsRef.current = 1;
    chimeTimerRef.current = setInterval(() => {
      if (repeatsRef.current >= CHIME_MAX_REPEATS) {
        stopChimeCycle();
        return;
      }
      if (!chime()) {
        stopChimeCycle();
        return;
      }
      repeatsRef.current += 1;
    }, CHIME_REPEAT_MS);
    return true;
  }, [chime, stopChimeCycle]);

  const handleEnableSound = useCallback(async () => {
    setSoundError(null);
    const ctx = ensureCtx();
    if (!ctx) {
      setSoundError("Audio alerts are unavailable in this browser.");
      toast.error("Audio alerts are not supported by this browser.");
      return;
    }
    try {
      await resumeAudioContext(ctx);
      if (ctx.state !== "running") throw new Error("Audio is still blocked");
      setSoundBlocked(false);
      setSoundError(null);
      if (unackedRef.current && startChimeCycle()) {
        const chimed = new Set(chimedRef.current);
        for (const id of latestLeadIdsRef.current) chimed.add(id);
        chimedRef.current = chimed;
        localStorage.setItem(CHIMED_STORAGE_KEY, serializeChimedLeadIds(chimed));
      }
    } catch {
      setSoundError("Allow audio for Marley Ops, then try again.");
      toast.error("Sound is blocked. Allow audio for Marley Ops and try again.");
    }
  }, [ensureCtx, startChimeCycle]);

  // --- polling --------------------------------------------------------------
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) return;
    const sequence = ++pollSequenceRef.current;
    try {
      const [rows, osNotifiedAt] = await Promise.all([
        fetchUnackedWebLeads(),
        readLastOsNotificationAt(),
      ]);
      if (sequence !== pollSequenceRef.current) return;
      latestLeadIdsRef.current = rows.map((lead) => lead.id);
      setLeads((previous) => {
        const unchanged =
          previous.length === rows.length &&
          previous.every(
            (lead, index) =>
              lead.id === rows[index]?.id &&
              lead.name === rows[index]?.name &&
              lead.created_at === rows[index]?.created_at,
          );
        return unchanged ? previous : rows;
      });
      unackedRef.current = rows.length > 0;

      // Merge cross-tab state before every decision. The OS marker is written
      // by the worker only after showNotification succeeds, including while the
      // PWA is closed, so returning to the app cannot double-sound that lead.
      const alreadyChimed = new Set(chimedRef.current);
      for (const id of parseChimedLeadIds(localStorage.getItem(CHIMED_STORAGE_KEY))) {
        alreadyChimed.add(id);
      }
      const coveredAt = Math.max(osNotifiedAt ?? 0, claimedAtRef.current);
      if (coveredAt > 0) {
        for (const lead of rows) {
          const createdAt = Date.parse(lead.created_at);
          if (Number.isFinite(createdAt) && createdAt <= coveredAt + 60_000) {
            alreadyChimed.add(lead.id);
          }
        }
      }

      const decision = nextChimeState(
        alreadyChimed,
        rows.map((r) => r.id),
      );
      if (rows.length === 0) {
        chimedRef.current = decision.chimed;
        localStorage.removeItem(CHIMED_STORAGE_KEY);
        stopChimeCycle();
      } else {
        // A blocked AudioContext is not a successful alert claim. Leave those
        // ids unclaimed so Enable sound (or the next eligible poll) can retry.
        const chimed = !decision.restart || startChimeCycle() ? decision.chimed : alreadyChimed;
        chimedRef.current = chimed;
        localStorage.setItem(CHIMED_STORAGE_KEY, serializeChimedLeadIds(chimed));
      }
    } catch {
      /* transient — keep last state, retry next tick */
    }
  }, [startChimeCycle, stopChimeCycle]);

  useEffect(() => {
    chimedRef.current = parseChimedLeadIds(localStorage.getItem(CHIMED_STORAGE_KEY));

    // Prime the browser audio context silently on the first normal interaction.
    // If a lead is already waiting, keep the explicit Enable sound action shown
    // rather than turning an unrelated click into a surprise chime.
    const primeAudio = () => {
      window.removeEventListener("pointerdown", primeAudio);
      window.removeEventListener("keydown", primeAudio);
      const ctx = ensureCtx();
      if (!ctx || ctx.state === "running") return;
      void ctx.resume().then(() => {
        if (!unackedRef.current) setSoundBlocked(false);
      }).catch(() => {});
    };

    const initialPoll = setTimeout(() => void poll(), 0);
    const interval = setInterval(() => void poll(), ALERT_POLL_MS);
    const onFocus = () => void poll();
    const onVisible = () => {
      if (document.hidden) stopChimeCycle();
      else void poll();
    };
    const onBlur = () => stopChimeCycle();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CHIMED_STORAGE_KEY) return;
      const merged = new Set(chimedRef.current);
      for (const id of parseChimedLeadIds(event.newValue)) merged.add(id);
      chimedRef.current = merged;
    };
    // Web Push nudge: when the app is focused the service worker suppresses
    // the OS notification for a new enquiry and messages us instead — poll
    // NOW so the banner + chime fire instantly rather than on the next tick.
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; category?: string; tag?: string } | null;
      if (data?.type === "mm-audio-claim" && data.category === "new_enquiry") {
        const eligible = !document.hidden && document.hasFocus();
        const claimed = eligible && startChimeCycle();
        if (claimed) {
          claimedAtRef.current = Date.now();
          void poll();
        }
        event.ports[0]?.postMessage({ claimed });
        return;
      }
      if (data?.type === "mm-push" && data.category === "new_enquiry") void poll();
    };
    window.addEventListener("pointerdown", primeAudio);
    window.addEventListener("keydown", primeAudio);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
      // Without startMessages() (or an onmessage assignment) the page's
      // message queue stays paused and postMessage from the SW never fires.
      navigator.serviceWorker.startMessages?.();
    }
    return () => {
      clearInterval(interval);
      clearTimeout(initialPoll);
      window.removeEventListener("pointerdown", primeAudio);
      window.removeEventListener("keydown", primeAudio);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onSwMessage);
      stopChimeCycle();
      ctxRef.current?.close().catch(() => {});
    };
  }, [ensureCtx, poll, startChimeCycle, stopChimeCycle]);

  // --- acknowledge ----------------------------------------------------------
  const handleAck = useCallback(async () => {
    const ids = leads.map((l) => l.id);
    if (ids.length === 0) return;
    // Invalidate overlapping poll responses before the acknowledgement starts;
    // an older response must not restore an already-cleared banner.
    pollSequenceRef.current += 1;
    stopChimeCycle();
    setAcking(true);
    try {
      const res = await ackWebLeadsAction(ids);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Optimistically silence + clear; the next poll confirms.
      chimedRef.current = new Set();
      latestLeadIdsRef.current = [];
      localStorage.removeItem(CHIMED_STORAGE_KEY);
      unackedRef.current = false;
      setLeads([]);
    } catch {
      toast.error("Could not acknowledge — try again.");
    } finally {
      setAcking(false);
    }
  }, [leads, stopChimeCycle]);

  if (leads.length === 0) return null;

  const count = leads.length;
  const names = leads.map((l) => l.name).join(", ");
  const heading = count === 1 ? "New website lead" : `${count} new website leads`;
  const href = count === 1 ? `/leads/${leads[0].id}` : "/leads";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 top-0 z-[100] px-3 pt-3 sm:px-4"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-lg border border-l-4 border-border border-l-[#C03838] bg-white px-4 py-3 shadow-lg">
        <span aria-hidden className="mt-1 size-2.5 shrink-0 animate-pulse rounded-full bg-[#C03838]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{heading}</p>
          <p className="truncate text-sm text-muted-foreground">
            {names}
            {" · "}
            <Link href={href} className="font-medium text-[#C03838] underline-offset-4 hover:underline">
              {count === 1 ? "View lead" : "View leads"}
            </Link>
          </p>
        </div>
        {soundBlocked ? (
          <Button
            type="button"
            variant="outline"
            onClick={handleEnableSound}
            title={soundError ?? "Enable audible new-lead alerts"}
            className="min-h-[44px] shrink-0 gap-2"
          >
            <Volume2 className="size-4" aria-hidden />
            {soundError ? "Try sound again" : "Enable sound"}
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={handleAck}
          disabled={acking}
          className="min-h-[44px] shrink-0 bg-[#C03838] text-white hover:bg-[#a82f2f]"
        >
          {acking ? "…" : "Acknowledge"}
        </Button>
      </div>
    </div>
  );
}
