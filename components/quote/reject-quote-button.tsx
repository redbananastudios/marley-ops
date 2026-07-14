"use client";

/**
 * "Reject quote" with a required reason — the office-side twin of the
 * customer's online decline (Peter, 2026-07-10: the quote page had no
 * "too expensive"-style reject like the lead's Mark-lost). Shows only on SENT
 * quotes; the reason feeds the Performance "why we lose" breakdown, and the
 * lead is marked lost automatically when this was its last live quote.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ThumbsDown } from "lucide-react";
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
import { rejectQuote } from "@/app/(dashboard)/quotes/actions";
import { LOSS_REASONS } from "@/lib/quote/chase";

export function RejectQuoteButton({
  quoteId,
  status,
  open: openProp,
  onOpenChange,
}: {
  quoteId: string;
  status: string;
  /** Controlled mode: driven from the quote header's "⋯ More" overflow menu. */
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const router = useRouter();
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setOpenState;
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  // Reset the form each time the dialog opens (covers both the built-in trigger
  // and the header-controlled path, which has no trigger onClick to reset in).
  useEffect(() => {
    if (open) {
      setReason(null);
      setNote("");
    }
  }, [open]);

  // Only SENT quotes reject; the header guards this too, but keep the uncontrolled
  // guard so a stray render can't show it on a draft/accepted quote.
  if (!controlled && status !== "sent") return null;

  function submit() {
    if (!reason) {
      toast.error("Pick a reason — it's how we improve.");
      return;
    }
    start(async () => {
      const res = await rejectQuote(quoteId, reason, note);
      if (!res.ok) {
        toast.error(res.error || "Could not reject the quote.");
        return;
      }
      toast.success(
        res.leadLost
          ? "Quote rejected — the lead is marked lost and chasing has stopped."
          : "Quote rejected. The lead stays live (another quote is still in play).",
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {controlled ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-semibold text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
        >
          <ThumbsDown className="size-3.5" strokeWidth={1.75} />
          Reject quote
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Reject quote</DialogTitle>
            <DialogDescription>
              Records why this quote didn&apos;t land (it feeds the &quot;why we lose&quot; report).
              If it&apos;s the lead&apos;s only live quote, the lead is marked lost and chasing stops.
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
                      ? "border-mm-red bg-mm-red-tint text-mm-red-deep"
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
              placeholder="Optional note — their budget, who they chose, anything worth remembering…"
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
              Reject quote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
