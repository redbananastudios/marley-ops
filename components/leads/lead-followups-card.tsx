"use client";

/**
 * Lead-page follow-ups strip — the OPEN follow-ups for this one lead, shown on the
 * Overview above the payments/activity area. Compact by design (the full triage
 * lives on /follow-ups); each row carries the same complete/snooze actions the
 * queue uses, wired to the same server actions so behaviour can't drift. Renders
 * nothing when there's nothing outstanding.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, Check, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  cancelFollowUpAction,
  completeFollowUpAction,
  snoozeFollowUpAction,
  type FollowUpOutcome,
} from "@/app/(dashboard)/follow-ups/actions";

export interface LeadFollowUp {
  id: string;
  reason: string;
  dueAt: string;
  attempts: number;
  assignedName: string | null;
  notes: string | null;
}

const REASON_LABEL: Record<string, string> = {
  no_answer: "No answer",
  deposit: "Deposit",
  balance: "Balance",
  quote_followup: "Quote follow-up",
  custom: "Follow-up",
};

const OUTCOMES: { value: FollowUpOutcome; label: string }[] = [
  { value: "reached", label: "Reached them" },
  { value: "paid", label: "Paid" },
  { value: "declined", label: "Declined" },
  { value: "no_answer_exhausted", label: "No answer — given up" },
  { value: "cancelled", label: "No longer needed" },
];

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function dueMeta(dueAt: string): { label: string; tone: "danger" | "warn" | "muted" } {
  const t = new Date(dueAt).getTime();
  if (Number.isNaN(t)) return { label: "—", tone: "muted" };
  if (t < startOfToday()) {
    const days = Math.max(1, Math.floor((Date.now() - t) / 86_400_000));
    return { label: `${days}d overdue`, tone: "danger" };
  }
  if (t <= endOfToday()) return { label: "Due today", tone: "warn" };
  return { label: new Date(dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), tone: "muted" };
}

export function LeadFollowUpsCard({ rows }: { rows: LeadFollowUp[] }) {
  if (rows.length === 0) return null;
  return (
    <Card className="p-0">
      <div className="border-b px-5 py-3.5">
        <h2 className="font-display text-lg text-foreground">
          Open follow-ups
          <span className="tabular ml-2 rounded-pill bg-muted px-1.5 text-xs font-medium text-mist-400">
            {rows.length}
          </span>
        </h2>
      </div>
      <ul className="divide-y">
        {rows.map((r) => (
          <Row key={r.id} r={r} />
        ))}
      </ul>
    </Card>
  );
}

function Row({ r }: { r: LeadFollowUp }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const due = dueMeta(r.dueAt);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error || "Something went wrong.");
      else {
        toast.success(ok);
        router.refresh();
      }
    });
  }

  const iconBtn =
    "focus-ring flex size-9 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-sm font-medium text-foreground">{REASON_LABEL[r.reason] ?? "Follow-up"}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs font-medium",
              due.tone === "danger" ? "text-danger" : due.tone === "warn" ? "text-warn" : "text-mist-400",
            )}
          >
            <Clock className="size-3.5" strokeWidth={1.75} />
            {due.label}
          </span>
          {r.attempts > 0 ? (
            <span className="tabular text-xs text-mist-400">
              {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
            </span>
          ) : null}
          {r.assignedName ? <span className="text-xs text-mist-400">{r.assignedName}</span> : null}
        </div>
        {r.notes ? <p className="mt-0.5 line-clamp-1 text-xs text-mist-400">{r.notes}</p> : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}

        {/* Snooze — same options as the /follow-ups queue */}
        <Select
          value=""
          onValueChange={(v) => {
            if (v === "cancel") {
              if (confirm("Cancel this follow-up?")) run(() => cancelFollowUpAction(r.id), "Cancelled.");
              return;
            }
            run(() => snoozeFollowUpAction(r.id, plusDays(Number(v))), "Snoozed.");
          }}
        >
          <SelectTrigger
            className="h-9 w-9 justify-center border-0 bg-transparent p-0 shadow-none hover:bg-muted [&>svg:last-child]:hidden"
            aria-label="Snooze"
          >
            <AlarmClock className="size-4 text-mist-400" strokeWidth={1.75} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="1">Tomorrow</SelectItem>
            <SelectItem value="3">In 3 days</SelectItem>
            <SelectItem value="7">In a week</SelectItem>
            <SelectItem value="cancel">Cancel follow-up</SelectItem>
          </SelectContent>
        </Select>

        {/* Done with outcome — same server action + outcomes as the queue */}
        {outcomeOpen ? (
          <Select
            open
            onOpenChange={(o) => !o && setOutcomeOpen(false)}
            value=""
            onValueChange={(v) => {
              setOutcomeOpen(false);
              run(() => completeFollowUpAction(r.id, v as FollowUpOutcome), "Done.");
            }}
          >
            <SelectTrigger
              className="h-9 w-9 justify-center border-0 bg-transparent p-0 shadow-none [&>svg:last-child]:hidden"
              aria-label="Outcome"
            >
              <Check className="size-4 text-success" strokeWidth={2} />
            </SelectTrigger>
            <SelectContent align="end">
              {OUTCOMES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <button
            type="button"
            onClick={() => setOutcomeOpen(true)}
            disabled={pending}
            title="Mark done"
            aria-label="Mark done"
            className={cn(iconBtn, "text-success")}
          >
            <Check className="size-4" strokeWidth={2} />
          </button>
        )}
      </div>
    </li>
  );
}
