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
 * gesture, so if the context is suspended we arm one-time pointer/key
 * listeners that resume it and chime if the batch is still unacked. Audio is
 * best-effort: the banner never depends on it and nothing here throws.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ackWebLeadsAction, getUnackedWebLeadsAction } from "@/app/actions/lead-alerts";
import {
  ALERT_POLL_MS,
  CHIME_MAX_REPEATS,
  CHIME_REPEAT_MS,
  nextChimeState,
  type UnackedWebLead,
} from "@/lib/lead-alerts";

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext };

export function NewLeadAlert() {
  const [leads, setLeads] = useState<UnackedWebLead[]>([]);
  const [acking, setAcking] = useState(false);

  const chimedRef = useRef<Set<string>>(new Set());
  const unackedRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const gestureArmedRef = useRef(false);
  const chimeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatsRef = useRef(0);

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

  const armGesture = useCallback(() => {
    if (gestureArmedRef.current || typeof window === "undefined") return;
    gestureArmedRef.current = true;
    const onGesture = () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      gestureArmedRef.current = false;
      const ctx = ctxRef.current;
      if (!ctx) return;
      ctx
        .resume()
        .then(() => {
          if (unackedRef.current) playTone(ctx);
        })
        .catch(() => {});
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
  }, [playTone]);

  const chime = useCallback(() => {
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      // Autoplay policy: try to resume; if still blocked, wait for a gesture.
      ctx.resume().then(() => playTone(ctx)).catch(() => {});
      armGesture();
      return;
    }
    playTone(ctx);
  }, [ensureCtx, playTone, armGesture]);

  const stopChimeCycle = useCallback(() => {
    if (chimeTimerRef.current !== null) {
      clearInterval(chimeTimerRef.current);
      chimeTimerRef.current = null;
    }
    repeatsRef.current = 0;
  }, []);

  const startChimeCycle = useCallback(() => {
    stopChimeCycle();
    chime();
    repeatsRef.current = 1;
    chimeTimerRef.current = setInterval(() => {
      if (repeatsRef.current >= CHIME_MAX_REPEATS) {
        stopChimeCycle();
        return;
      }
      chime();
      repeatsRef.current += 1;
    }, CHIME_REPEAT_MS);
  }, [chime, stopChimeCycle]);

  // --- polling --------------------------------------------------------------
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const rows = await getUnackedWebLeadsAction();
      setLeads(rows);
      unackedRef.current = rows.length > 0;
      const decision = nextChimeState(
        chimedRef.current,
        rows.map((r) => r.id),
      );
      chimedRef.current = decision.chimed;
      if (rows.length === 0) stopChimeCycle();
      else if (decision.restart) startChimeCycle();
    } catch {
      /* transient — keep last state, retry next tick */
    }
  }, [startChimeCycle, stopChimeCycle]);

  useEffect(() => {
    void poll();
    const interval = setInterval(() => void poll(), ALERT_POLL_MS);
    const onFocus = () => void poll();
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    // Web Push nudge: when the app is focused the service worker suppresses
    // the OS notification for a new enquiry and messages us instead — poll
    // NOW so the banner + chime fire instantly rather than on the next tick.
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; category?: string } | null;
      if (data?.type === "mm-push" && data.category === "new_enquiry") void poll();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
      // Without startMessages() (or an onmessage assignment) the page's
      // message queue stays paused and postMessage from the SW never fires.
      navigator.serviceWorker.startMessages?.();
    }
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onSwMessage);
      stopChimeCycle();
      ctxRef.current?.close().catch(() => {});
    };
  }, [poll, stopChimeCycle]);

  // --- acknowledge ----------------------------------------------------------
  const handleAck = useCallback(async () => {
    const ids = leads.map((l) => l.id);
    if (ids.length === 0) return;
    setAcking(true);
    try {
      const res = await ackWebLeadsAction(ids);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Optimistically silence + clear; the next poll confirms.
      stopChimeCycle();
      chimedRef.current = new Set();
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
