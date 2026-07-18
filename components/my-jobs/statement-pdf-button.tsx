"use client";

/**
 * Download a crew contractor invoice as a branded PDF — same browser pdfMake
 * pipeline as the quote / job-sheet PDFs. Data is passed in from the server
 * (already RLS-scoped); the logo is fetched + cached client-side.
 */

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PdfLoader } from "@/components/quote/pdf-loader";
import { ensureLogoDataUri } from "@/lib/quote/pdf-client";
import { buildStatementDocDef, type StatementPdfData } from "@/lib/staff/statement-docdef";

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

export function StatementPdfButton({ data, className }: { data: StatementPdfData; className?: string }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const ready = await waitForPdfMake();
      if (!ready) {
        toast.error("The PDF engine didn't load — check the connection and try again.");
        return;
      }
      const logoDataUri = await ensureLogoDataUri();
      const blob = await blobToPdf(buildStatementDocDef({ ...data, logoDataUri }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contractor-invoice-${data.ref}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("Invoice downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the invoice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PdfLoader />
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className={cn(
          "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50",
          className,
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <FileText className="size-4" strokeWidth={1.75} />}
        {busy ? "Preparing…" : "Download PDF"}
      </button>
    </>
  );
}
