"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { updateLeadStatusAction } from "@/app/(dashboard)/leads/actions";
import { isBackwardMove } from "@/lib/leads/funnel";
import { MarkLostDialog } from "@/components/leads/mark-lost-button";
import { StatusReasonDialog } from "@/components/leads/status-reason-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function StatusChanger({ leadId, status }: { leadId: string; status: string }) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  // Server truth wins: after any router.refresh() the fresh status prop
  // reseeds the select — useState alone would pin the first render's value
  // for the life of the tab, and a stale value feeds the backward check.
  useEffect(() => setValue(status), [status]);
  // Backward moves collect a reason first. The pair is SNAPSHOTTED when the
  // gate opens so the dialog header can't show the optimistically-updated
  // value ("X → X") while the confirm is in flight.
  const [reasonFor, setReasonFor] = useState<{ from: string; to: string } | null>(null);
  // "Declined" routes through the full mark-lost flow (reason + unwind)
  // instead of a raw status write.
  const [lostOpen, setLostOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const label = (s: string) => LEAD_STATUS_META[s]?.label ?? s;

  function apply(next: string) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
      try {
        const res = await updateLeadStatusAction(leadId, next);
        if (res.ok) {
          toast.success(`Status updated to ${label(next)}`);
          router.refresh();
          return;
        }
        setValue(previous);
        if ("needsReason" in res && res.needsReason) {
          // Our copy of the status was stale — the server says this move is
          // actually backward. Resync and collect the reason so the move can
          // still complete instead of dead-ending on the same rejection.
          setReasonFor({ from: previous, to: next });
          router.refresh();
          return;
        }
        toast.error(res.error ?? "Could not update status");
        // A failure often means this tab was stale (e.g. the lead moved in
        // another window) — resync so the next attempt runs on server truth.
        router.refresh();
      } catch (err) {
        setValue(previous);
        toast.error(err instanceof Error ? err.message : "Could not update status");
      }
    });
  }

  async function applyWithReason(next: string, reason: string): Promise<boolean> {
    const previous = value;
    setValue(next);
    try {
      const res = await updateLeadStatusAction(leadId, next, { reason });
      if (res.ok) {
        toast.success(`Status updated to ${label(next)}`);
        router.refresh();
        return true;
      }
      setValue(previous);
      toast.error(res.error ?? "Could not update status");
      router.refresh();
      return false;
    } catch (err) {
      setValue(previous);
      toast.error(err instanceof Error ? err.message : "Could not update status");
      return false;
    }
  }

  function onChange(next: string) {
    if (next === value) return;
    if (next === "declined") {
      setLostOpen(true);
      return;
    }
    if (isBackwardMove(value, next)) {
      setReasonFor({ from: value, to: next });
      return;
    }
    apply(next);
  }

  return (
    <div className="flex items-center gap-2">
      {isPending ? (
        <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} aria-label="Saving" />
      ) : null}
      <Select value={value} onValueChange={onChange} disabled={isPending}>
        <SelectTrigger size="sm" className="min-h-11 min-w-[10rem]" aria-label="Change lead status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LEAD_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {LEAD_STATUS_META[s]?.label ?? s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <StatusReasonDialog
        open={reasonFor !== null}
        onOpenChange={(o) => {
          if (!o) setReasonFor(null);
        }}
        fromLabel={reasonFor ? label(reasonFor.from) : ""}
        toLabel={reasonFor ? label(reasonFor.to) : ""}
        onConfirm={(reason) =>
          reasonFor ? applyWithReason(reasonFor.to, reason) : Promise.resolve(false)
        }
      />

      <MarkLostDialog
        leadId={leadId}
        open={lostOpen}
        onOpenChange={setLostOpen}
        onDone={() => setValue("declined")}
      />
    </div>
  );
}
