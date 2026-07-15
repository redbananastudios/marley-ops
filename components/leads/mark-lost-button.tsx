"use client";

/**
 * "Mark lost" with a required reason — the improvement loop. Replaces the old
 * bare confirm(): every loss now records WHY (feeds the Performance breakdown)
 * and stops the chase engine. Leads are never deleted.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { markLeadLostAction } from "@/app/(dashboard)/leads/actions";
import { LOSS_REASONS } from "@/lib/quote/chase";

export function MarkLostButton({ leadId, className }: { leadId: string; className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    if (!reason) {
      toast.error("Pick a reason — it's how we improve.");
      return;
    }
    start(async () => {
      const res = await markLeadLostAction(leadId, reason, note);
      if (!res.ok) {
        toast.error(res.error || "Could not mark lost.");
        return;
      }
      const bits = [
        res.apptsCancelled ? `${res.apptsCancelled} appointment${res.apptsCancelled === 1 ? "" : "s"} cancelled` : null,
        res.voidedInvoices ? `${res.voidedInvoices} unpaid invoice${res.voidedInvoices === 1 ? "" : "s"} voided in Zoho` : null,
      ].filter(Boolean);
      toast.success(`Marked lost.${bits.length ? ` ${bits.join(" · ")}.` : ""}`);
      if (res.refundTask) {
        toast.warning("Money was already paid on this job — a refund-decision task is in Follow-ups.");
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setReason(null);
          setNote("");
          setOpen(true);
        }}
        className={
          className ??
          "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
        }
      >
        <X className="size-4" strokeWidth={1.75} />
        Mark lost
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Mark lost</DialogTitle>
            <DialogDescription>
              The lead keeps its history and chasing stops. The reason feeds the
              &quot;why we lose quotes&quot; report.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              {LOSS_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setReason(r.value)}
                  aria-pressed={reason === r.value}
                  className={cn(
                    "focus-ring min-h-11 rounded-md border px-3 text-sm font-medium transition-colors",
                    reason === r.value
                      ? "border-mm-red bg-mm-red text-white"
                      : "border-input bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note — anything worth remembering (their price, who they chose…)"
              rows={2}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={pending || !reason}
              className="bg-mm-red text-white hover:bg-mm-red-deep"
            >
              {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Mark lost
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
