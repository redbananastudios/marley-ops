"use client";

import { useState, useTransition } from "react";
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
  // Backward moves collect a reason first; "Declined" routes through the full
  // mark-lost flow (reason + unwind) instead of a raw status write.
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const label = (s: string) => LEAD_STATUS_META[s]?.label ?? s;

  function apply(next: string) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const res = await updateLeadStatusAction(leadId, next);
      if (res.ok) {
        toast.success(`Status updated to ${label(next)}`);
        router.refresh();
      } else {
        setValue(previous);
        toast.error(res.error ?? "Could not update status");
      }
    });
  }

  async function applyWithReason(next: string, reason: string): Promise<boolean> {
    const previous = value;
    setValue(next);
    const res = await updateLeadStatusAction(leadId, next, { reason });
    if (res.ok) {
      toast.success(`Status updated to ${label(next)}`);
      router.refresh();
      return true;
    }
    setValue(previous);
    toast.error(res.error ?? "Could not update status");
    return false;
  }

  function onChange(next: string) {
    if (next === value) return;
    if (next === "declined") {
      setLostOpen(true);
      return;
    }
    if (isBackwardMove(value, next)) {
      setReasonFor(next);
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
        fromLabel={label(value)}
        toLabel={reasonFor ? label(reasonFor) : ""}
        onConfirm={(reason) => (reasonFor ? applyWithReason(reasonFor, reason) : Promise.resolve(false))}
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
