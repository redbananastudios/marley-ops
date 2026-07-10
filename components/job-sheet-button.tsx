"use client";

/**
 * "Job sheet" button — fetches the sheet data server-side, builds the PDF in
 * the browser (window.pdfMake via <PdfLoader/>, same pipeline as the quote
 * PDF) and downloads it. Used on the Job Board (office) and /my-jobs (crew).
 */

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PdfLoader } from "@/components/quote/pdf-loader";
import { getJobSheetDataAction } from "@/app/actions/job-sheet";
import { buildJobSheetDocDef } from "@/lib/job-sheet-docdef";

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
    if (typeof window === "undefined" || !window.pdfMake) {
      toast.error("PDF engine still loading — try again in a second.");
      return;
    }
    setBusy(true);
    try {
      const res = await getJobSheetDataAction(appointmentId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const slug = (fileHint || "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      window.pdfMake.createPdf(buildJobSheetDocDef(res.data)).download(`job-sheet-${slug}.pdf`);
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
          Job sheet (PDF)
        </button>
      )}
    </>
  );
}
