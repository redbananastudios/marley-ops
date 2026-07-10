"use client";

/**
 * Typed e-signature rendering (Peter, 2026-07-10: desktop signers type their
 * name and we "write" it in a handwritten face — the DocuSign pattern).
 *
 * Two halves:
 *  - <ScriptSignature/>  live preview of the typed name in the Signature
 *    Script face (Great Vibes, self-hosted).
 *  - renderNameToPng()   rasterises the same rendering to a PNG data URI so
 *    the stored evidence + certificates carry an image, exactly like a
 *    finger-drawn signature. Fail-soft: null when the canvas/font can't
 *    deliver (the typed name itself remains the legal signature).
 */

export function ScriptSignature({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={
        className ??
        "flex min-h-16 items-center justify-center rounded-md border border-dashed border-input bg-white px-4"
      }
    >
      {name.trim() ? (
        <span style={{ fontFamily: "'Signature Script', cursive", fontSize: 34, lineHeight: 1.1, color: "#1F1D1B" }}>
          {name.trim()}
        </span>
      ) : (
        <span className="text-sm text-mist-300">Your signature appears here</span>
      )}
    </div>
  );
}

export async function renderNameToPng(name: string): Promise<string | null> {
  const text = name.trim();
  if (!text) return null;
  try {
    if (document.fonts?.load) await document.fonts.load("48px 'Signature Script'");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const font = "48px 'Signature Script', cursive";
    ctx.font = font;
    const w = Math.min(900, Math.max(320, Math.ceil(ctx.measureText(text).width) + 60));
    canvas.width = w * 2;
    canvas.height = 220;
    const c2 = canvas.getContext("2d");
    if (!c2) return null;
    c2.scale(2, 2);
    c2.font = font;
    c2.fillStyle = "#1F1D1B";
    c2.textBaseline = "middle";
    c2.fillText(text, 30, 55);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
