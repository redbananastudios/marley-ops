"use client";

/**
 * Office control for the automatic post-move review-request email. Three states:
 *  (a) already sent — show the date, no toggle;
 *  (b) will send after completion — a switch-off button;
 *  (c) switched off — show why/when (from the latest activity), a re-enable button.
 * Off is for a customer who wasn't fully satisfied; auto-set when the crew record
 * exceptions at sign-off (a missed ask is cheap, asking an unhappy customer isn't).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Star, StarOff, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { setReviewSuppressionAction } from "@/app/(dashboard)/leads/actions";

function fmt(d: string | null | undefined): string {
  if (!d) return "";
  const t = new Date(d);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function ReviewRequestControl({
  leadId,
  reviewRequestedAt,
  reviewSuppressed,
  suppressionNote,
}: {
  leadId: string;
  reviewRequestedAt: string | null;
  reviewSuppressed: boolean;
  /** Latest "switched off" activity, if any — powers the "why/when" line. */
  suppressionNote?: { summary: string; at: string | null } | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [suppressed, setSuppressed] = useState(reviewSuppressed);

  function toggle(next: boolean) {
    const previous = suppressed;
    setSuppressed(next);
    startTransition(async () => {
      const res = await setReviewSuppressionAction(leadId, next);
      if (res.ok) {
        toast.success(next ? "Review request switched off" : "Review request re-enabled");
        router.refresh();
      } else {
        setSuppressed(previous);
        toast.error(res.error ?? "Could not update the review request");
      }
    });
  }

  // (a) Already sent — nothing to toggle.
  if (reviewRequestedAt) {
    return (
      <Card className="flex items-center gap-3 p-5">
        <CheckCircle2 className="size-5 shrink-0 text-success" strokeWidth={1.75} />
        <div>
          <p className="eyebrow">Review request</p>
          <p className="mt-0.5 text-sm text-foreground">Sent{fmt(reviewRequestedAt) ? ` on ${fmt(reviewRequestedAt)}` : ""}</p>
        </div>
      </Card>
    );
  }

  // (c) Switched off — show why/when + re-enable.
  if (suppressed) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <StarOff className="mt-0.5 size-5 shrink-0 text-mist-400" strokeWidth={1.75} />
          <div>
            <p className="eyebrow">Review request</p>
            <p className="mt-0.5 text-sm text-foreground">Switched off — this customer won&apos;t be asked for a review.</p>
            {suppressionNote?.summary ? (
              <p className="mt-1 text-xs text-mist-400">
                {suppressionNote.summary}
                {fmt(suppressionNote.at) ? ` · ${fmt(suppressionNote.at)}` : ""}
              </p>
            ) : null}
          </div>
        </div>
        <Button variant="outline" size="sm" className="min-h-11" disabled={isPending} onClick={() => toggle(false)}>
          {isPending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Star strokeWidth={1.75} />}
          Switch back on
        </Button>
      </Card>
    );
  }

  // (b) On — will send after completion; offer to switch off.
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
      <div className="flex items-start gap-3">
        <Star className="mt-0.5 size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <p className="eyebrow">Review request</p>
          <p className="mt-0.5 text-sm text-foreground">On — the review email sends automatically once the move is complete.</p>
          <p className="mt-1 text-xs text-mist-400">Switch off if the customer wasn&apos;t fully satisfied.</p>
        </div>
      </div>
      <Button variant="outline" size="sm" className="min-h-11" disabled={isPending} onClick={() => toggle(true)}>
        {isPending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <StarOff strokeWidth={1.75} />}
        Switch off
      </Button>
    </Card>
  );
}
