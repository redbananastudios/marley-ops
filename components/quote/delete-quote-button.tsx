"use client";

/**
 * Delete a quote. Drafts/rejected delete after a simple confirm; sent/accepted
 * show an extra warning that this removes a recorded win (they feed Won £ /
 * win-rate / estimator stats) before allowing it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
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
import { deleteQuote } from "@/app/(dashboard)/quotes/actions";

export function DeleteQuoteButton({
  quoteId,
  status,
  quoteRef,
  open: openProp,
  onOpenChange,
}: {
  quoteId: string;
  status: string;
  quoteRef: string;
  /** Controlled mode: driven from the quote header's "⋯ More" overflow menu. */
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const router = useRouter();
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setOpenState;
  const [busy, setBusy] = useState(false);
  const protectedStatus = status === "sent" || status === "accepted";

  async function confirm() {
    setBusy(true);
    const res = await deleteQuote(quoteId);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not delete the quote.");
      return;
    }
    toast.success(`Quote ${quoteRef} deleted.`);
    setOpen(false);
    router.push("/quotes");
  }

  return (
    <>
      {controlled ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Delete quote"
          title="Delete quote"
          className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 transition-colors hover:bg-danger-bg hover:text-danger"
        >
          <Trash2 className="size-4" strokeWidth={1.75} />
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Delete quote {quoteRef}?</DialogTitle>
            <DialogDescription>
              {protectedStatus
                ? "This quote is " +
                  status +
                  " — deleting it removes a recorded win from your Won £, win rate and estimator stats. This can't be undone."
                : "This permanently deletes the quote. This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={confirm}
              disabled={busy}
              className="bg-danger text-white hover:bg-danger/90"
            >
              {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Trash2 className="size-4" strokeWidth={1.75} />}
              {protectedStatus ? "Delete anyway" : "Delete quote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
