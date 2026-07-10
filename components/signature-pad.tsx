"use client";

/**
 * Finger/stylus signature pad — plain <canvas> with pointer events, no
 * library. iPad-first: touch-action none (no scroll while signing), generous
 * height, Clear button. Emits a PNG data URI after every stroke (null when
 * empty) so the parent can gate its submit button.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";

export function SignaturePad({
  onChange,
  label = "Sign here",
}: {
  onChange: (dataUri: string | null) => void;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Size the bitmap to the rendered box (device-pixel crisp) once mounted.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.25;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1F1D1B";
    }
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const emit = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    onChange(hasInk.current ? c.toDataURL("image/png") : null);
  }, [onChange]);

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    // A dot counts: draw a tiny segment so single taps leave ink.
    ctx.lineTo(x + 0.01, y + 0.01);
    ctx.stroke();
    hasInk.current = true;
    setEmpty(false);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    emit();
  }

  function clear() {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    hasInk.current = false;
    setEmpty(true);
    onChange(null);
  }

  return (
    <div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="h-36 w-full rounded-md border border-input bg-white"
          style={{ touchAction: "none" }}
          aria-label={label}
        />
        {empty ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-mist-300">
            {label}
          </span>
        ) : null}
        <button
          type="button"
          onClick={clear}
          aria-label="Clear signature"
          className="focus-ring absolute right-2 top-2 flex size-9 items-center justify-center rounded-md border border-input bg-card text-mist-400 hover:text-foreground"
        >
          <Eraser className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
