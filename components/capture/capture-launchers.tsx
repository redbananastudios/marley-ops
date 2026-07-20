"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import type { CaptureAnchor } from "@/components/capture/capture-sheet";

const CaptureSheet = dynamic(
  () => import("@/components/capture/capture-sheet").then((module) => module.CaptureSheet),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 text-white"
      >
        <span className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-medium shadow-lg">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Opening capture…
        </span>
      </div>
    ),
  },
);

function useCaptureSheet() {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  function show() {
    setHasOpened(true);
    setOpen(true);
  }

  return { open, hasOpened, show, close: () => setOpen(false) };
}

/** The floating capture button (crew job page) — opens the sheet. */
export function CaptureFab({ anchor, captureCount }: { anchor: CaptureAnchor; captureCount?: number }) {
  const sheet = useCaptureSheet();
  return (
    <>
      <button
        type="button"
        onClick={sheet.show}
        aria-label="Capture photos, video or a voice note"
        className="focus-ring fixed bottom-[calc(env(safe-area-inset-bottom)+92px)] right-4 z-40 flex size-14 items-center justify-center rounded-full bg-mm-red text-white shadow-lg transition-transform active:scale-95"
      >
        <Camera className="size-6" strokeWidth={1.75} />
        {captureCount ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-semibold text-[#1F1D1B]">
            {captureCount > 99 ? "99+" : captureCount}
          </span>
        ) : null}
      </button>
      {sheet.hasOpened ? <CaptureSheet anchor={anchor} open={sheet.open} onClose={sheet.close} /> : null}
    </>
  );
}

/** Inline launcher for office surfaces (lead page action bar). */
export function CaptureLauncher({ anchor, className }: { anchor: CaptureAnchor; className?: string }) {
  const sheet = useCaptureSheet();
  return (
    <>
      <button
        type="button"
        onClick={sheet.show}
        className={
          className ??
          "focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
        }
      >
        <Camera className="size-4" strokeWidth={1.75} />
        Capture
      </button>
      {sheet.hasOpened ? <CaptureSheet anchor={anchor} open={sheet.open} onClose={sheet.close} /> : null}
    </>
  );
}
