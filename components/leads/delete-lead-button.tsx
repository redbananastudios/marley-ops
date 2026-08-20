"use client";

/**
 * Delete a duplicate lead. Admin-only and deliberately understated — it sits
 * quiet at the end of the action bar because it is the one lead action with no
 * undo. The confirmation names the customer and says plainly what survives,
 * because "are you sure?" on its own is not enough beside a real pipeline.
 *
 * The server refuses anything carrying a quote, money, a diary slot or a
 * signature (lib/leads/deletable.ts), so the worst outcome of a mis-tap is a
 * refusal explaining why.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteLeadAction } from "@/app/(dashboard)/leads/actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DeleteLeadButton({
  leadId,
  leadName,
  hasSibling,
}: {
  leadId: string;
  leadName: string | null;
  /** Exactly one other lead on this client — its history will move there. */
  hasSibling: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" /> Delete
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this lead?</DialogTitle>
          <DialogDescription>
            {leadName ? `${leadName}'s ` : "This "}enquiry will be removed for good. There is no undo.
            {hasSibling
              ? " Its notes, emails and follow-ups will move to the other enquiry for this customer."
              : " Its activity history goes with it."}{" "}
            The customer record itself is kept.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Use this for duplicates. A lead with a quote, a payment, a diary slot or a signed
          document can&apos;t be deleted, mark it lost instead.
        </p>
        <DialogFooter>
          <button
            type="button"
            className="focus-ring min-h-11 rounded-lg border border-input px-4 text-sm font-medium"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Keep it
          </button>
          <button
            type="button"
            className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await deleteLeadAction(leadId);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                setOpen(false);
                toast.success(
                  res.mergedInto ? "Duplicate deleted, its history was kept" : "Lead deleted",
                );
                router.push("/leads");
                router.refresh();
              })
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Delete lead
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
