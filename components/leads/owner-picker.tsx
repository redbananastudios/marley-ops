"use client";

/** Inline owner (estimator) assignment for a lead. Drives the "Mine" filter and
 *  pay/win attribution. Optimistic; reverts on error. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignLeadOwnerAction } from "@/app/(dashboard)/leads/actions";

const NONE = "__none__";

export function OwnerPicker({
  leadId,
  ownerId,
  estimators,
}: {
  leadId: string;
  ownerId: string | null;
  estimators: { id: string; full_name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(ownerId ?? NONE);
  const [pending, start] = useTransition();

  function onChange(next: string) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await assignLeadOwnerAction(leadId, next === NONE ? null : next);
      if (res.ok) {
        toast.success("Owner updated.");
        router.refresh();
      } else {
        setValue(prev);
        toast.error(res.error || "Could not assign owner.");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}
      <Select value={value} onValueChange={onChange} disabled={pending}>
        <SelectTrigger size="sm" className="min-h-9 min-w-[9rem]" aria-label="Assign owner">
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Unassigned</SelectItem>
          {estimators.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.full_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
