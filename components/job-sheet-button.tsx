"use client";

/**
 * "Job sheet" button — fetches the sheet data server-side, builds the PDF in
 * the browser (window.pdfMake via <PdfLoader/>, same pipeline as the quote
 * PDF) and downloads it. Used on the Job Board (office) and /my-jobs (crew).
 *
 * Robustness rules learned the hard way:
 *  - WAIT for pdfMake instead of erroring — the loader is async and a fast
 *    tap after page-load used to dead-end with "engine still loading".
 *  - Download via an explicit blob + anchor, not pdfmake's own .download()
 *    (which failed silently in some browsers).
 */

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PdfLoader } from "@/components/quote/pdf-loader";
import { getJobSheetDataAction } from "@/app/actions/job-sheet";
import { buildJobSheetDocDef } from "@/lib/job-sheet-docdef";

// window.pdfMake's ambient (any-typed) declaration lives in lib/quote/pdf-client.ts.

/** Resolve once window.pdfMake (core + vfs fonts) is usable, up to ~15s. */
function waitForPdfMake(): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (window.pdfMake?.vfs) return resolve(true);
      if (Date.now() - started > 15_000) return resolve(false);
      setTimeout(poll, 250);
    };
    poll();
  });
}

function blobToPdf(def: unknown): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("PDF render timed out")), 20_000);
    try {
      window.pdfMake!.createPdf(def).getBlob((b: Blob) => {
        clearTimeout(t);
        resolve(b);
      });
    } catch (e) {
      clearTimeout(t);
      reject(e);
    }
  });
}

export function JobSheetButton({
  appointmentId,
  fileHint,
  variant = "full",
}: {
  appointmentId: string;
  fileHint: string;
  variant?: "full" | "icon";
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const [ready, res] = await Promise.all([waitForPdfMake(), getJobSheetDataAction(appointmentId)]);
      if (!ready) {
        toast.error("The PDF engine didn't load — check the connection and try again.");
        return;
      }
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const blob = await blobToPdf(buildJobSheetDocDef(res.data));
      const slug = (fileHint || "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `job-sheet-${slug}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("Job sheet downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the job sheet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PdfLoader />
      {variant === "icon" ? (
        <button
          type="button"
          onClick={download}
          disabled={busy}
          aria-label="Download job sheet"
          title="Job sheet (PDF)"
          className="focus-ring flex size-7 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <FileText className="size-3.5" strokeWidth={1.75} />}
        </button>
      ) : (
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className={cn(
            "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50",
          )}
        >
          {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <FileText className="size-4" strokeWidth={1.75} />}
          {busy ? "Preparing…" : "Job sheet (PDF)"}
        </button>
      )}
    </>
  );
}
