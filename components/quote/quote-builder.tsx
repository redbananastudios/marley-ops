"use client";

/**
 * Quote builder — the centrepiece. A single 7-step wizard over QuoteFormValues
 * with a live total (computeQuote), debounced silent autosave, PDF download, and
 * the send dialog. Ported from the live MM Quotes tool but rebuilt on the Marley
 * Ops design tokens and the shared pricing/comms/PDF contracts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { computeQuote } from "@/lib/quote/pricing";
import { deriveInputs, defaultQuoteValues, type QuoteFormValues } from "@/lib/quote/form-types";
import { saveQuoteDraft, setQuoteStatus } from "@/app/(dashboard)/quotes/actions";
import { PdfLoader } from "@/components/quote/pdf-loader";
import { downloadQuotePdf, ensureLogoDataUri } from "@/lib/quote/pdf-client";
import {
  Step1Customer,
  Step2Job,
  Step3Vehicle,
  Step4Access,
  Step5Extras,
  Step6Items,
  Step7Review,
} from "@/components/quote/wizard-steps";
import { SendQuoteDialog } from "@/components/quote/send-quote-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const QUOTE_STATUSES: { value: string; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "superseded", label: "Superseded" },
];

/** Header status control — changes quote status inline. */
export function QuoteStatusControl({ quoteId, status }: { quoteId: string; status: string }) {
  const [value, setValue] = useState(status);
  const [busy, setBusy] = useState(false);
  async function change(next: string) {
    setValue(next);
    setBusy(true);
    const res = await setQuoteStatus(quoteId, next);
    setBusy(false);
    if (!res.ok) {
      setValue(status);
      toast.error("Could not update status: " + res.error);
    } else {
      toast.success(`Status set to ${next}.`);
    }
  }
  return (
    <Select value={value} onValueChange={change} disabled={busy}>
      <SelectTrigger className="h-9 w-[150px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {QUOTE_STATUSES.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const TOTAL_STEPS = 7;
const STEP_LABELS = [
  "Customer",
  "Job details",
  "Vehicle & packing",
  "Access & property",
  "Additional charges",
  "Items & materials",
  "Review & send",
];

export function QuoteBuilder({
  quoteId,
  quoteRef,
  initialValues,
  leadId,
  clientId,
  estimatorName,
  readOnly,
}: {
  quoteId: string;
  quoteRef: string;
  initialValues?: QuoteFormValues | null;
  leadId?: string | null;
  clientId?: string | null;
  estimatorName?: string | null;
  readOnly?: boolean;
}) {
  const [values, setValues] = useState<QuoteFormValues>(() => ({
    ...defaultQuoteValues(),
    ...(initialValues ?? {}),
  }));
  const [step, setStep] = useState(1);
  const [sendOpen, setSendOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const breakdown = useMemo(() => computeQuote(deriveInputs(values)), [values]);

  /* ---- typed setter passed into every step ---- */
  const set = useCallback(
    <K extends keyof QuoteFormValues>(key: K, value: QuoteFormValues[K]) => {
      setValues((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  /* ---- debounced silent autosave (~800ms) ---- */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (readOnly) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await saveQuoteDraft(quoteId, values);
      if (!res.ok) toast.error("Could not autosave: " + res.error);
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [values, quoteId, readOnly]);

  /* ---- warm the logo for PDF generation once ---- */
  useEffect(() => {
    ensureLogoDataUri().catch(() => {});
  }, []);

  async function handleDownloadPdf() {
    setPdfBusy(true);
    try {
      await downloadQuotePdf(values, breakdown, { quoteRef, estimatorName: estimatorName ?? undefined });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  const goNext = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const reviewActions = (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setSendOpen(true)}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white hover:bg-mm-red-deep active:bg-mm-red-deep"
      >
        <Mail className="size-5" strokeWidth={1.75} />
        Send quote by email
      </button>
      <button
        type="button"
        onClick={handleDownloadPdf}
        disabled={pdfBusy}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-md border border-input bg-card text-base font-semibold text-foreground active:bg-muted disabled:opacity-60"
      >
        {pdfBusy ? (
          <Loader2 className="size-5 animate-spin" strokeWidth={1.75} />
        ) : (
          <Download className="size-5" strokeWidth={1.75} />
        )}
        Download PDF
      </button>
    </div>
  );

  return (
    <div className="pb-28">
      {/* progress dots */}
      <nav aria-label="Quote steps" className="mb-6 flex items-center gap-1.5">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const active = n === step;
          const done = n < step;
          return (
            <button
              key={label}
              type="button"
              onClick={() => setStep(n)}
              aria-label={`Step ${n}: ${label}`}
              aria-current={active ? "step" : undefined}
              className={cn(
                "h-2 rounded-full transition-all",
                active ? "w-8 bg-mm-red" : done ? "w-2 bg-mm-red/50" : "w-2 bg-mist-200",
              )}
            />
          );
        })}
        <span className="ml-3 text-xs font-medium text-mist-400">
          Step {step} / {TOTAL_STEPS} · {STEP_LABELS[step - 1]}
        </span>
      </nav>

      {/* current step body */}
      <div className="rounded-lg border border-border bg-card p-5 md:p-6">
        {step === 1 && <Step1Customer values={values} set={set} />}
        {step === 2 && <Step2Job values={values} set={set} />}
        {step === 3 && <Step3Vehicle values={values} set={set} />}
        {step === 4 && <Step4Access values={values} set={set} />}
        {step === 5 && <Step5Extras values={values} set={set} />}
        {step === 6 && <Step6Items values={values} set={set} />}
        {step === 7 && (
          <Step7Review values={values} set={set} breakdown={breakdown} actions={reviewActions} />
        )}
      </div>

      {/* sticky bottom bar — live total + nav */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1}
            className="flex h-11 items-center gap-1 rounded-md border border-input bg-card px-4 text-sm font-semibold text-foreground active:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            Back
          </button>

          <div className="text-center">
            <p className="eyebrow leading-none">Quote total</p>
            <p className="font-display tabular text-2xl font-bold leading-tight text-foreground">
              {gbp(breakdown.grandTotal)}
            </p>
          </div>

          {step < TOTAL_STEPS ? (
            <button
              type="button"
              onClick={goNext}
              className="flex h-11 items-center gap-1 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
            >
              Continue
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSendOpen(true)}
              className="flex h-11 items-center gap-1 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
            >
              <Mail className="size-4" strokeWidth={1.75} />
              Send
            </button>
          )}
        </div>
      </div>

      {/* off-screen PDF engine loader */}
      <PdfLoader />

      <SendQuoteDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        quoteId={quoteId}
        quoteRef={quoteRef}
        values={values}
        breakdown={breakdown}
        leadId={leadId}
        clientId={clientId}
        estimatorName={estimatorName}
      />
    </div>
  );
}
