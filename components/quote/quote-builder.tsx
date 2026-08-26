"use client";

/**
 * Quote builder — the centrepiece. A single 7-step wizard over QuoteFormValues
 * with a live total (computeQuote), debounced silent autosave, PDF download, and
 * the send dialog. Ported from the live MM Quotes tool but rebuilt on the Marley
 * Ops design tokens and the shared pricing/comms/PDF contracts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Download, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { computeQuote, DEFAULT_PRICING, type PricingConfig } from "@/lib/quote/pricing";
import type { BusinessSettings } from "@/lib/settings";
import { deriveInputs, defaultQuoteValues, type QuoteFormValues } from "@/lib/quote/form-types";
import type { Brand } from "@/lib/brand";
import { saveQuoteDraft } from "@/app/(dashboard)/quotes/actions";
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
  type CubicQuoteHint,
} from "@/components/quote/wizard-steps";
import { SendQuoteDialog } from "@/components/quote/send-quote-dialog";
import { EstimatorPicker } from "@/components/quote/estimator-picker";

const QUOTE_STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-mist-500" },
  sent: { label: "Sent", cls: "bg-[#eff6ff] text-[#2563eb]" },
  accepted: { label: "Accepted", cls: "bg-success-bg text-success" },
  rejected: { label: "Rejected", cls: "bg-danger-bg text-danger" },
  superseded: { label: "Superseded", cls: "bg-muted text-mist-400" },
};

/**
 * Read-only status badge. Quote status is driven by real actions — Send → "sent",
 * Accept → "accepted" — never set by hand, so a brand-new quote can't be mis-marked
 * as Sent/Accepted before anything has actually happened.
 */
export function QuoteStatusBadge({ status }: { status: string }) {
  const meta = QUOTE_STATUS_META[status] ?? QUOTE_STATUS_META.draft;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        meta.cls,
      )}
    >
      {meta.label}
    </span>
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
  estimatorId,
  estimators,
  readOnly,
  pricing = DEFAULT_PRICING,
  settings,
  acceptUrl,
  cubicHint,
  brand,
}: {
  quoteId: string;
  quoteRef: string;
  initialValues?: QuoteFormValues | null;
  leadId?: string | null;
  clientId?: string | null;
  estimatorName?: string | null;
  /** Who this quote is assigned to — drives the email sender (accounts@ when null). */
  estimatorId?: string | null;
  /** Assignable office members (active admin/estimator) for the sender picker. */
  estimators?: { id: string; full_name: string }[];
  readOnly?: boolean;
  /** Active (settings-driven) prices for the live total + step labels. */
  pricing?: PricingConfig;
  /** Cost rates — powers the internal margin % on Review & Send. */
  settings?: BusinessSettings | null;
  /** Customer accept page (/q/<token>) — renders the PDF QR codes + email CTA. */
  acceptUrl?: string;
  /** Cubic-survey van suggestion, shown on the Vehicle step. */
  cubicHint?: CubicQuoteHint | null;
  /** The quote's brand row (multi-brand PRD §3.5) — absent/marley sends
   *  today's exact email. */
  brand?: Brand | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState<QuoteFormValues>(() => ({
    ...defaultQuoteValues(),
    ...(initialValues ?? {}),
  }));
  const [step, setStep] = useState(1);
  const [sendOpen, setSendOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [showStep1Errors, setShowStep1Errors] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const breakdown = useMemo(() => computeQuote(deriveInputs(values), pricing), [values, pricing]);

  const step1Valid =
    values.customer.name.trim() !== "" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.customer.email.trim());

  // Step 2 gate: the route mileage must have been calculated before the quote can
  // proceed — the price depends on dead + job miles, so an un-calculated route
  // would price off defaults. Both legs present === the "Calculate route &
  // mileage" step ran (Peter, 2026-07-30).
  const step2Valid = values.route.deadMiles != null && values.route.jobMiles != null;

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
      setSaveState("saving");
      const res = await saveQuoteDraft(quoteId, values);
      if (!res.ok) {
        setSaveState("idle");
        toast.error("Could not autosave: " + res.error);
      } else {
        setSaveState("saved");
      }
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
      await downloadQuotePdf(values, breakdown, {
        quoteRef,
        estimatorName: estimatorName ?? undefined,
        vatNumber: settings?.vatNumber || undefined,
        depositAmount: settings?.defaultDeposit || undefined,
        acceptUrl,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  // "Save as draft" — the quote already autosaves on every edit, but this makes
  // it explicit that the quote is parked for a colleague to pick up. Flush a
  // final save first (cancelling the pending debounce) so the "Saved" is truthful
  // even when the user edits and immediately saves within the 800ms window, then
  // leave for the Quotes list. Does NOT touch the send flow.
  async function handleSaveDraft() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setDraftBusy(true);
    const res = await saveQuoteDraft(quoteId, values);
    setDraftBusy(false);
    if (!res.ok) {
      toast.error("Could not save: " + res.error);
      return;
    }
    toast.success("Saved as draft");
    router.push("/quotes");
  }

  const goNext = () => {
    if (step === 1 && !step1Valid) {
      setShowStep1Errors(true);
      toast.error("Add the customer's name and a valid email to continue.");
      return;
    }
    if (step === 2 && !step2Valid) {
      toast.error("Calculate the route & mileage before continuing.");
      return;
    }
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  // Progress-dot navigation. Going BACK (or to the current step) is always fine;
  // jumping FORWARD must clear the SAME gates as Next, so the dots can't bypass
  // the step-1 (customer) or step-2 (mileage) gates (reviewer, 2026-07-30).
  const goToStep = (n: number) => {
    if (n <= step) {
      setStep(n);
      return;
    }
    if (!step1Valid) {
      setShowStep1Errors(true);
      toast.error("Add the customer's name and a valid email to continue.");
      return;
    }
    if (n > 2 && !step2Valid) {
      toast.error("Calculate the route & mileage before continuing.");
      return;
    }
    setStep(n);
  };

  const reviewActions = (
    <div className="space-y-3">
      {/* Who the quote email sends from — the assigned estimator, or the Accounts
          money desk when left as Office / Accounts. Sits above Send so it's set
          before the email goes out. Read-only quotes never render this builder. */}
      <EstimatorPicker quoteId={quoteId} estimatorId={estimatorId ?? null} estimators={estimators ?? []} />
      <button
        type="button"
        onClick={() => setSendOpen(true)}
        className="focus-ring flex h-14 w-full items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white hover:bg-mm-red-deep active:bg-mm-red-deep"
      >
        <Mail className="size-5" strokeWidth={1.75} />
        Send quote by email
      </button>
      {/* Explicit "park it for a colleague" — the autosave already persisted the
          quote, so this just confirms + returns to the list. */}
      <button
        type="button"
        onClick={handleSaveDraft}
        disabled={draftBusy}
        className="focus-ring flex h-14 w-full items-center justify-center gap-2 rounded-md border border-input bg-card text-base font-semibold text-foreground hover:bg-muted active:bg-muted disabled:opacity-60"
      >
        {draftBusy ? <Loader2 className="size-5 animate-spin" strokeWidth={1.75} /> : null}
        Save as draft
      </button>
      <button
        type="button"
        onClick={handleDownloadPdf}
        disabled={pdfBusy}
        className="focus-ring flex h-14 w-full items-center justify-center gap-2 rounded-md border border-input bg-card text-base font-semibold text-foreground hover:bg-muted active:bg-muted disabled:opacity-60"
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
              onClick={() => goToStep(n)}
              aria-label={`Step ${n}: ${label}${done ? ", completed" : ""}`}
              aria-current={active ? "step" : undefined}
              className="focus-ring flex h-11 items-center rounded-sm px-1"
            >
              <span
                className={cn(
                  "h-2 rounded-full transition-all",
                  active ? "w-8 bg-mm-red" : done ? "w-2 bg-mm-red/50" : "w-2 bg-mist-200",
                )}
              />
            </button>
          );
        })}
        <span className="ml-3 text-xs font-medium text-mist-400">
          Step {step} / {TOTAL_STEPS} · {STEP_LABELS[step - 1]}
        </span>
      </nav>

      {/* current step body */}
      <div className="rounded-lg border border-border bg-card p-6 md:p-7">
        {step === 1 && <Step1Customer values={values} set={set} showErrors={showStep1Errors} />}
        {step === 2 && <Step2Job values={values} set={set} pricing={pricing} />}
        {step === 3 && <Step3Vehicle values={values} set={set} leadId={leadId} pricing={pricing} cubicHint={cubicHint} />}
        {step === 4 && <Step4Access values={values} set={set} leadId={leadId} />}
        {step === 5 && <Step5Extras values={values} set={set} />}
        {step === 6 && <Step6Items values={values} set={set} leadId={leadId} />}
        {step === 7 && (
          <Step7Review
            values={values}
            set={set}
            breakdown={breakdown}
            actions={reviewActions}
            settings={settings}
          />
        )}
      </div>

      {/* sticky bottom bar — live total + nav. Offset by the sidebar (w-64, only
          shown at xl) so its centred row lines up with the wizard card, not the
          viewport; below xl the sidebar is hidden so the bar spans full width. */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 xl:left-64">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3 md:px-8">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1}
            className="focus-ring flex h-11 items-center gap-1 rounded-md border border-input bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted active:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            Back
          </button>

          <div className="text-center">
            <p className="eyebrow leading-none">Quote total</p>
            <p className="font-display tabular text-2xl font-bold leading-tight text-foreground">
              {gbp(breakdown.grandTotal)}
            </p>
            {/* persistent, always-on-screen autosave reassurance (fixed height
                so the total never shifts). Read-only quotes never autosave. */}
            {!readOnly ? (
              <p
                className="mt-0.5 flex h-4 items-center justify-center gap-1 text-[11px] font-medium text-mist-400"
                aria-live="polite"
              >
                {saveState === "saving" ? (
                  <>
                    <Loader2 className="size-3 animate-spin" strokeWidth={1.75} /> Saving…
                  </>
                ) : saveState === "saved" ? (
                  <>
                    <Check className="size-3 text-success" strokeWidth={2} /> All changes saved
                  </>
                ) : null}
              </p>
            ) : null}
          </div>

          {step < TOTAL_STEPS ? (
            <button
              type="button"
              onClick={goNext}
              className="focus-ring flex h-11 items-center gap-1 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
            >
              Continue
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSendOpen(true)}
              className="focus-ring flex h-11 items-center gap-1 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
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
        brand={brand}
        values={values}
        breakdown={breakdown}
        leadId={leadId}
        clientId={clientId}
        estimatorName={estimatorName}
        vatNumber={settings?.vatNumber || undefined}
        depositAmount={settings?.defaultDeposit || undefined}
        acceptUrl={acceptUrl}
        onSent={() => {
          // Sent successfully — leave the editable wizard for the read-only job
          // card (the quote is now "sent"), so the estimator isn't stranded mid-form.
          router.replace(`/quotes/${quoteId}`);
          router.refresh();
        }}
      />
    </div>
  );
}
