"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { updateLeadStatusAction } from "@/app/(dashboard)/leads/actions";
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
  const [isPending, startTransition] = useTransition();

  function onChange(next: string) {
    if (next === value) return;
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const res = await updateLeadStatusAction(leadId, next);
      if (res.ok) {
        toast.success(`Status updated to ${LEAD_STATUS_META[next]?.label ?? next}`);
        router.refresh();
      } else {
        setValue(previous);
        toast.error(res.error ?? "Could not update status");
      }
    });
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
    </div>
  );
}
