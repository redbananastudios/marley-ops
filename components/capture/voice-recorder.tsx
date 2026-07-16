"use client";

/**
 * Voice note recorder — WhatsApp ergonomics (PRD §1): HOLD the mic to record
 * (live timer + pulsing ring), SLIDE UP to lock for hands-free, release to
 * finish. Instant playback with keep / discard. Container is runtime-detected
 * (Safari records mp4/AAC, Android Chrome webm/opus — never hardcode one).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Lock, Mic, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AUDIO_MIME_CANDIDATES, MAX_AUDIO_SECONDS } from "@/lib/job-media";

function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return AUDIO_MIME_CANDIDATES.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
}

const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

type Phase = "idle" | "recording" | "locked" | "review";

export function VoiceRecorder({
  disabled,
  onCaptured,
  onRecordingChange,
}: {
  disabled?: boolean;
  onCaptured: (capture: { blob: Blob; mime: string; durationS: number }) => void;
  /** Fires as recording starts/stops — the sheet guards close + mode switch on it. */
  onRecordingChange?: (recording: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [review, setReview] = useState<{ url: string; blob: Blob; mime: string; durationS: number } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const pointerStartY = useRef(0);
  // Pointer-down truth for the hold gesture — the first-use permission prompt
  // makes the finger lift while getUserMedia is still pending.
  const pointerDownRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const recordingLive = phase === "recording" || phase === "locked";
  useEffect(() => {
    onRecordingChange?.(recordingLive);
    return () => {
      // Unmounting mid-recording must not leave the sheet thinking one is live.
      if (recordingLive) onRecordingChange?.(false);
    };
  }, [recordingLive, onRecordingChange]);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* already stopped */
      }
      teardownStream();
      if (review) URL.revokeObjectURL(review.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live timer + hard cap (stops via the recorder directly — keeps this effect
  // free of forward references).
  useEffect(() => {
    if (phase !== "recording" && phase !== "locked") return;
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(s);
      if (s >= MAX_AUDIO_SECONDS) {
        try {
          recorderRef.current?.stop();
        } catch {
          /* already stopped */
        }
      }
    }, 250);
    return () => clearInterval(t);
  }, [phase]);

  const startRecording = useCallback(async () => {
    if (disabled || phaseRef.current !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!pointerDownRef.current) {
        // The finger lifted to answer the permission prompt — the hold gesture
        // is over, so never leave a recording running unattended.
        stream.getTracks().forEach((t) => t.stop());
        toast("Mic enabled — hold the button to record.");
        return;
      }
      const mime = pickAudioMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        teardownStream();
        const durationS = Math.round((Date.now() - startedAtRef.current) / 1000);
        const type = recorder.mimeType || mime || "audio/mp4";
        if (cancelledRef.current || durationS < 1 || chunksRef.current.length === 0) {
          setPhase("idle");
          setSeconds(0);
          return;
        }
        const blob = new Blob(chunksRef.current, { type });
        setReview({ url: URL.createObjectURL(blob), blob, mime: type, durationS });
        setPhase("review");
      };
      recorder.start(1000);
      setSeconds(0);
      setPhase("recording");
      buzz(10);
    } catch {
      toast.error("Microphone not available — check the app's permission in Settings.");
      setPhase("idle");
    }
  }, [disabled, teardownStream]);

  const stopRecording = useCallback((cancelled: boolean) => {
    cancelledRef.current = cancelled;
    try {
      recorderRef.current?.stop();
    } catch {
      setPhase("idle");
    }
    buzz(10);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      pointerDownRef.current = true;
      pointerStartY.current = e.clientY;
      void startRecording();
    },
    [startRecording],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (phaseRef.current !== "recording") return;
    if (pointerStartY.current - e.clientY > 64) {
      setPhase("locked");
      buzz(10);
    }
  }, []);

  const onPointerUp = useCallback(() => {
    pointerDownRef.current = false;
    // Locked recordings keep going until the stop button; a plain release ends it.
    if (phaseRef.current === "recording") stopRecording(false);
  }, [stopRecording]);

  const discardReview = useCallback(() => {
    if (review) URL.revokeObjectURL(review.url);
    setReview(null);
    setSeconds(0);
    setPhase("idle");
  }, [review]);

  const keepReview = useCallback(() => {
    if (!review) return;
    onCaptured({ blob: review.blob, mime: review.mime, durationS: review.durationS });
    // The object URL is handed off with the tray preview — the sheet revokes it.
    setReview(null);
    setSeconds(0);
    setPhase("idle");
  }, [onCaptured, review]);

  const mm = String(Math.floor(seconds / 60)).padStart(1, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  if (phase === "review" && review) {
    return (
      <div className="flex w-full flex-col items-center gap-4 px-6">
        <audio src={review.url} controls className="w-full max-w-sm" />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={discardReview}
            className="focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-white/25 px-5 text-sm font-medium text-white/90"
          >
            <Trash2 className="size-4" strokeWidth={1.75} /> Discard
          </button>
          <button
            type="button"
            onClick={keepReview}
            className="focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-mm-red px-6 text-sm font-semibold text-white"
          >
            <Check className="size-4" strokeWidth={2} /> Keep it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex h-8 items-center gap-2 text-sm text-white/80" aria-live="polite">
        {recordingLive ? (
          <>
            <span className="inline-block size-2 animate-pulse rounded-full bg-mm-red" />
            <span className="tabular-nums font-medium text-white">{mm}:{ss}</span>
            {phase === "locked" ? (
              <span className="inline-flex items-center gap-1 text-white/70">
                <Lock className="size-3.5" strokeWidth={1.75} /> hands-free
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-white/70">
                <ArrowUp className="size-3.5" strokeWidth={1.75} /> slide up to lock
              </span>
            )}
          </>
        ) : (
          <span className="text-white/70">Hold to record a voice note — access, story, anything useful</span>
        )}
      </div>

      {phase === "locked" ? (
        <button
          type="button"
          onClick={() => stopRecording(false)}
          aria-label="Stop recording"
          className="focus-ring flex size-20 items-center justify-center rounded-full bg-mm-red text-white shadow-lg"
        >
          <Square className="size-7 fill-current" strokeWidth={0} />
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Hold to record"
          style={{ touchAction: "none" }}
          className={`focus-ring flex size-20 items-center justify-center rounded-full text-white transition-transform disabled:opacity-50 ${
            recordingLive ? "scale-110 bg-mm-red shadow-[0_0_0_12px_rgba(192,56,56,0.25)]" : "bg-mm-red active:scale-95"
          }`}
        >
          <Mic className="size-8" strokeWidth={1.75} />
        </button>
      )}
      <p className="text-[11px] text-white/50">Up to 3 minutes · transcribed automatically for the office</p>
    </div>
  );
}
