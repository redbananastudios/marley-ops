"use client";

/**
 * On-site completion sign-off (Peter, 2026-07-10): exceptions box, customer
 * signature (or customer-absent + reason), crew-lead signature. Builds the
 * completion certificate PDF ON THIS DEVICE (window.pdfMake — signatures are
 * already here as data URIs) and hands it to the server, which stores it and
 * emails the customer. Price-free end to end.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/signature-pad";
import { PdfLoader } from "@/components/quote/pdf-loader";
import { buildCompletionCertDocDef, type CompletionCertData } from "@/lib/completion-cert-docdef";
import { completeJobAction } from "@/app/actions/crew-signatures";
import { useOutbox } from "@/components/offline/outbox-provider";
import { PendingSyncBadge } from "@/components/offline/offline-sync-bar";
import type { JobCompletionPayload } from "@/components/offline/runners";

// window.pdfMake's ambient declaration lives in lib/quote/pdf-client.ts.

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

function pdfToBase64(def: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Certificate render timed out")), 20_000);
    try {
      window.pdfMake!.createPdf(def).getBase64((b64: string) => {
        clearTimeout(t);
        resolve(b64);
      });
    } catch (e) {
      clearTimeout(t);
      reject(e);
    }
  });
}

export interface CompletionJobInfo {
  appointmentId: string;
  customerName: string;
  quoteRef: string | null;
  moveDate: string | null;
  fromLine: string;
  toLine: string;
  crewNameDefault: string;
}

export function CompleteJobButton({ job, triggerClassName }: { job: CompletionJobInfo; triggerClassName?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [exceptions, setExceptions] = useState("");
  const [absent, setAbsent] = useState(false);
  const [absentReason, setAbsentReason] = useState("");
  const [custName, setCustName] = useState(job.customerName);
  const [custSig, setCustSig] = useState<string | null>(null);
  const [crewName, setCrewName] = useState(job.crewNameDefault);
  const [crewSig, setCrewSig] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const outbox = useOutbox();
  const queuedItem = outbox.items.find((i) => i.kind === "job_completion" && i.key === job.appointmentId);

  const ready =
    crewName.trim().length >= 2 &&
    !!crewSig &&
    (absent ? absentReason.trim().length >= 3 : custName.trim().length >= 2 && !!custSig);

  function submit() {
    start(async () => {
      // Build the certificate on-device; a PDF failure never blocks the
      // completion record — the server accepts a null certificate.
      let certB64: string | null = null;
      try {
        if (await waitForPdfMake()) {
          const cert: CompletionCertData = {
            quoteRef: job.quoteRef,
            customerName: absent ? job.customerName : custName.trim(),
            moveDate: job.moveDate,
            from: job.fromLine,
            to: job.toLine,
            crewName: crewName.trim(),
            crewSignature: crewSig!,
            customerSignature: absent ? null : custSig,
            customerAbsent: absent,
            absentReason: absentReason.trim(),
            exceptions: exceptions.trim(),
            signedAtLabel: new Date().toLocaleString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "Europe/London",
            }),
          };
          certB64 = await pdfToBase64(buildCompletionCertDocDef(cert));
        }
      } catch {
        certB64 = null;
      }

      const input = {
        exceptions,
        customerAbsent: absent,
        customerName: custName,
        customerSignature: custSig,
        absentReason,
        crewName,
        crewSignature: crewSig!,
        certificatePdfBase64: certB64,
      };
      const payload: JobCompletionPayload = { appointmentId: job.appointmentId, input };

      // Queue to the on-device outbox so nothing done in a dead spot is lost;
      // it replays on reconnect and the server dedupes on appointment_id.
      const queueForLater = async () => {
        try {
          await outbox.enqueue({
            kind: "job_completion",
            key: job.appointmentId,
            payload,
            label: `Completion — ${(absent ? job.customerName : custName.trim()) || "customer"}`,
          });
          toast.success("Saved on your phone — it'll sync when you're back in signal.");
          setOpen(false);
        } catch {
          // Can't even persist locally (e.g. private-mode Safari) — fail loudly.
          toast.error("Couldn't save this on your phone. You'll need signal to finish the job.");
        }
      };

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await queueForLater();
        return;
      }

      try {
        const res = await completeJobAction(job.appointmentId, input);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.alreadyCompleted) toast.success("This job was already signed off.");
        else if (res.emailed) toast.success("Job completed — certificate emailed to the customer.");
        else toast.success(`Job completed.${res.emailNote ? ` ${res.emailNote}` : ""}`);
        setOpen(false);
        router.refresh();
      } catch {
        // Signal dropped mid-submit — don't lose it, queue it.
        await queueForLater();
      }
    });
  }

  // A completion queued (offline) or stuck on this job: show its sync state
  // rather than the Complete button, so the crew can't accidentally re-sign a
  // job they've already finished — and can retry a failed sync in one tap.
  if (queuedItem) {
    return (
      <button
        type="button"
        onClick={() => queuedItem.status === "failed" && void outbox.flush()}
        className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md px-2"
        aria-label={queuedItem.status === "failed" ? "Retry syncing this completion" : "Completion saved, waiting to sync"}
      >
        <PendingSyncBadge state={queuedItem.status} />
      </button>
    );
  }

  return (
    <>
      <PdfLoader />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          "focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-4 text-sm font-semibold text-white transition-colors hover:bg-mm-red-deep"
        }
      >
        <CheckCircle2 className="size-4" strokeWidth={1.75} />
        Complete job
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Complete job</DialogTitle>
            <DialogDescription>
              Note any exceptions, then both of you sign. The customer gets their completion
              certificate by email.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div>
              <label htmlFor="exceptions" className="eyebrow mb-1.5 block">
                Exceptions — anything missing or damaged?
              </label>
              <textarea
                id="exceptions"
                value={exceptions}
                onChange={(e) => setExceptions(e.target.value)}
                placeholder="Leave empty for “Nothing to report”."
                rows={2}
                className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-base"
              />
            </div>

            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5">
              <input
                type="checkbox"
                checked={absent}
                onChange={(e) => setAbsent(e.target.checked)}
                className="size-5 shrink-0 accent-mm-red"
              />
              <span className="text-sm text-foreground">Customer isn&apos;t available to sign</span>
            </label>

            {absent ? (
              <div>
                <label htmlFor="absent-reason" className="eyebrow mb-1.5 block">
                  Why? (goes on the record)
                </label>
                <input
                  id="absent-reason"
                  type="text"
                  value={absentReason}
                  onChange={(e) => setAbsentReason(e.target.value)}
                  placeholder="e.g. delivery into storage, nobody on site"
                  className="focus-ring h-12 w-full rounded-md border border-input bg-card px-3 text-base"
                />
                <p className="mt-1.5 text-xs text-mist-400">
                  The customer&apos;s email will ask them to check their items and reply within 48 hours.
                </p>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="cust-name" className="eyebrow mb-1.5 block">
                    Customer&apos;s name
                  </label>
                  <input
                    id="cust-name"
                    type="text"
                    value={custName}
                    onChange={(e) => setCustName(e.target.value)}
                    className="focus-ring h-12 w-full rounded-md border border-input bg-card px-3 text-base"
                  />
                </div>
                <div>
                  <p className="eyebrow mb-1.5">Customer&apos;s signature</p>
                  <SignaturePad onChange={setCustSig} label="Customer signs here" />
                </div>
              </>
            )}

            <div className="border-t pt-3">
              <div>
                <label htmlFor="crew-name" className="eyebrow mb-1.5 block">
                  Crew lead
                </label>
                <input
                  id="crew-name"
                  type="text"
                  value={crewName}
                  onChange={(e) => setCrewName(e.target.value)}
                  className="focus-ring h-12 w-full rounded-md border border-input bg-card px-3 text-base"
                />
              </div>
              <div className="mt-3">
                <p className="eyebrow mb-1.5">Crew lead&apos;s signature</p>
                <SignaturePad onChange={setCrewSig} label="Crew lead signs here" />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !ready} className="bg-mm-red text-white hover:bg-mm-red-deep">
              {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Sign off &amp; email certificate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
