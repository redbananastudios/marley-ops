"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { markEstimatorPaid } from "@/app/(dashboard)/performance/actions";

export function MarkPaidButton({
  estimatorId,
  periodMonth,
  visits,
  amount,
  paid,
}: {
  estimatorId: string;
  periodMonth: string;
  visits: number;
  amount: number;
  paid: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      const res = await markEstimatorPaid(estimatorId, periodMonth, visits, amount, !paid);
      if (!res.ok) toast.error(res.error || "Could not update.");
      else {
        toast.success(paid ? "Marked unpaid." : "Marked paid.");
        router.refresh();
      }
    });
  }

  if (paid) {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-success-border bg-success-bg px-3 text-sm font-medium text-success transition-colors hover:opacity-80 disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Check className="size-4" strokeWidth={2} />}
        Paid
        <RotateCcw className="ml-0.5 size-3 opacity-60" strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending || visits === 0}
      className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-medium text-white transition-colors hover:bg-mm-red-deep disabled:opacity-50"
    >
      {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Check className="size-4" strokeWidth={1.75} />}
      Mark paid
    </button>
  );
}
