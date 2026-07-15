"use client";

/**
 * Reason gate for BACKWARD pipeline moves (e.g. confirmed → quoted). A job
 * sliding back down the funnel usually means something went wrong — the reason
 * lands on the lead timeline so the move is never silent. Forward moves,
 * reopening a declined lead, and mark-lost (which has its own richer dialog)
 * never come through here. The server enforces the same rule, so this dialog
 * is UX, not the security boundary.
 */

import { useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
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

export function StatusReasonDialog({
  open,
  onOpenChange,
  fromLabel,
  toLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromLabel: string;
  toLabel: string;
  /** Runs the move; resolve true on success (closes the dialog), false to stay open. */
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  // Fresh form each open — one dialog instance can serve many rows.
  useEffect(() => {
    if (open) {
      setReason("");
      setPending(false);
    }
  }, [open]);

  async function submit() {
    if (!reason.trim()) {
      toast.error("Say why the job is moving backwards.");
      return;
    }
    setPending(true);
    try {
      const ok = await onConfirm(reason.trim());
      if (ok) onOpenChange(false);
    } catch (err) {
      // A thrown onConfirm (network drop, mid-deploy chunk failure) must not
      // die as an unhandled rejection — surface it and keep the dialog open
      // so the typed reason survives for a retry.
      toast.error(err instanceof Error ? err.message : "Could not save — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (pending ? null : onOpenChange(v))}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          // A typed reason must never be lost to a stray backdrop tap (the
          // board is iPad-first) — same convention as the email compose.
          if (pending || reason.trim()) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2 text-xl">
            <Undo2 className="size-5 text-warn" strokeWidth={1.75} />
            Move backwards?
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{fromLabel}</span> →{" "}
            <span className="font-medium text-foreground">{toLabel}</span>. A job moving back down
            the pipeline needs a reason — it goes on the lead&apos;s timeline.
          </DialogDescription>
        </DialogHeader>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. customer pushed the move date back and wants re-quoting"
          rows={3}
          maxLength={300}
          autoFocus
          className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-base"
          aria-label="Reason for moving backwards"
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !reason.trim()}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Move back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
