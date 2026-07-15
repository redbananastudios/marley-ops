"use client";

/**
 * The follow-ups work queue — "clear the work", not "hunt for the best job".
 * Sections: Overdue → Due today → Upcoming. Within a section: reason urgency
 * (no answer → deposit → balance → quote → custom), then oldest due, then value.
 * One-tap No Reply logs the attempt and requeues tomorrow morning; 3+ attempts
 * warns, 4+ suggests marking lost (advisory — nothing is automatic).
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Phone,
  PhoneMissed,
  Mail,
  MessageCircle,
  Check,
  Clock,
  AlarmClock,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { CommsDialog } from "@/components/comms/comms-dialog";
import { templateForReason } from "@/lib/comms/templates";
import {
  logNoReplyAction,
  completeFollowUpAction,
  snoozeFollowUpAction,
  cancelFollowUpAction,
  type FollowUpOutcome,
} from "@/app/(dashboard)/follow-ups/actions";

export interface FollowUpRow {
  id: string;
  leadId: string;
  reason: string;
  dueAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  notes: string | null;
  assignedName: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  moveDate: string | null;
  propertySize: string | null;
  postcode: string | null;
  quoteRef: string | null;
  amount: number | null;
}

const REASON_META: Record<string, { label: string; cls: string; rank: number }> = {
  no_answer: { label: "No answer", cls: "bg-danger-bg text-danger", rank: 0 },
  deposit: { label: "Deposit", cls: "bg-warn-bg text-warn", rank: 1 },
  balance: { label: "Balance", cls: "bg-warn-bg text-warn", rank: 2 },
  quote_followup: { label: "Quote follow-up", cls: "bg-[#eff6ff] text-[#2563eb]", rank: 3 },
  custom: { label: "Follow-up", cls: "bg-muted text-mist-500", rank: 4 },
};

const OUTCOMES: { value: FollowUpOutcome; label: string }[] = [
  { value: "reached", label: "Reached them" },
  { value: "paid", label: "Paid" },
  { value: "declined", label: "Declined" },
  { value: "no_answer_exhausted", label: "No answer — given up" },
  { value: "cancelled", label: "No longer needed" },
];

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dueLabel(dueAt: string): string {
  const t = new Date(dueAt).getTime();
  const now = Date.now();
  if (t < startOfToday()) {
    const days = Math.max(1, Math.floor((now - t) / 86_400_000));
    return `${days}d overdue`;
  }
  if (t <= endOfToday()) return "Due today";
  return new Date(dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export function FollowUpsQueue({ rows }: { rows: FollowUpRow[] }) {
  const groups = useMemo(() => {
    const cmp = (a: FollowUpRow, b: FollowUpRow) => {
      const r = (REASON_META[a.reason]?.rank ?? 9) - (REASON_META[b.reason]?.rank ?? 9);
      if (r !== 0) return r;
      const d = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      if (d !== 0) return d;
      return (b.amount ?? 0) - (a.amount ?? 0);
    };
    const overdue = rows.filter((r) => new Date(r.dueAt).getTime() < startOfToday()).sort(cmp);
    const today = rows
      .filter((r) => {
        const t = new Date(r.dueAt).getTime();
        return t >= startOfToday() && t <= endOfToday();
      })
      .sort(cmp);
    const upcoming = rows
      .filter((r) => new Date(r.dueAt).getTime() > endOfToday())
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    return { overdue, today, upcoming };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={AlarmClock}
          title="Nothing outstanding"
          hint="New follow-ups appear here from a lead's No-reply button, deposit/balance chases, or Add follow-up on the lead."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <Section title="Overdue" tone="danger" rows={groups.overdue} />
      <Section title="Due today" tone="normal" rows={groups.today} />
      <Section title="Upcoming" tone="muted" rows={groups.upcoming} />
    </div>
  );
}

function Section({ title, tone, rows }: { title: string; tone: "danger" | "normal" | "muted"; rows: FollowUpRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2
        className={cn(
          "mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em]",
          tone === "danger" ? "text-danger" : tone === "muted" ? "text-mist-400" : "text-mist-500",
        )}
      >
        {title}
        <span className="tabular rounded-pill bg-muted px-1.5 text-mist-400">{rows.length}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <FollowUpCard key={r.id} r={r} />
        ))}
      </div>
    </section>
  );
}

function FollowUpCard({ r }: { r: FollowUpRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const meta = REASON_META[r.reason] ?? REASON_META.custom;
  const overdue = new Date(r.dueAt).getTime() < startOfToday();
  const template = templateForReason(r.reason, {
    firstName: r.name,
    quoteRef: r.quoteRef,
    amount: r.amount,
    moveDate: r.moveDate ? fmtDate(r.moveDate) : null,
  });

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

  // Matches the central contact-action style (neutral; hover to foreground).
  const iconBtn =
    "focus-ring flex size-9 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-sm">
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/leads/${r.leadId}`} className="focus-ring truncate rounded-sm text-sm font-semibold text-foreground hover:underline">
              {r.name ?? "Unnamed lead"}
            </Link>
            <p className="truncate text-xs text-mist-400">
              {[r.postcode, r.propertySize].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <span className={cn("shrink-0 rounded-pill px-2 py-0.5 text-xs font-medium", meta.cls)}>{meta.label}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={cn("inline-flex items-center gap-1 font-medium", overdue ? "text-danger" : "text-mist-500")}>
            <Clock className="size-3.5" strokeWidth={1.75} />
            {dueLabel(r.dueAt)}
          </span>
          {r.attempts > 0 ? (
            <span className="tabular text-mist-500">
              {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
            </span>
          ) : null}
          {r.moveDate ? <span className="text-mist-500">Move {fmtDate(r.moveDate)}</span> : null}
          {r.amount != null ? <span className="tabular font-semibold text-foreground">{gbp(r.amount)}</span> : null}
          {r.assignedName ? <span className="text-mist-400">{r.assignedName}</span> : null}
        </div>

        {r.attempts >= 3 ? (
          <p
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium",
              r.attempts >= 4 ? "bg-danger-bg text-danger" : "bg-warn-bg text-warn",
            )}
          >
            <TriangleAlert className="size-3.5 shrink-0" strokeWidth={2} />
            {r.attempts >= 4 ? `${r.attempts} failed attempts — suggest marking lost / no response.` : `${r.attempts} failed attempts.`}
          </p>
        ) : null}

        {r.notes ? <p className="line-clamp-2 text-xs text-mist-400">{r.notes}</p> : null}
      </div>

      {/* actions */}
      <div className="flex items-center gap-0.5 border-t border-border bg-muted/30 px-2 py-1.5">
        {r.phone ? (
          <a href={`tel:${r.phone}`} title="Call" aria-label="Call" className={iconBtn}>
            <Phone className="size-4" strokeWidth={1.75} />
          </a>
        ) : null}
        <CommsDialog
          leadId={r.leadId}
          defaultEmail={r.email ?? undefined}
          defaultPhone={r.phone ?? undefined}
          initialSubject={template.subject}
          initialEmailBody={template.email}
          initialSmsBody={template.sms}
          trigger={
            <span className="contents">
              {r.email ? (
                <button type="button" title="Email (template prefilled)" aria-label="Email" className={iconBtn}>
                  <Mail className="size-4" strokeWidth={1.75} />
                </button>
              ) : r.phone ? (
                <button type="button" title="SMS (template prefilled)" aria-label="SMS" className={iconBtn}>
                  <MessageCircle className="size-4" strokeWidth={1.75} />
                </button>
              ) : null}
            </span>
          }
        />
        <button
          type="button"
          onClick={() => run(() => logNoReplyAction(r.id), "Logged — back in the queue tomorrow.")}
          disabled={pending}
          title="No reply — try again tomorrow"
          className="focus-ring flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-mm-red hover:bg-muted disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <PhoneMissed className="size-4" strokeWidth={1.75} />}
          No reply
        </button>

        {/* Snooze */}
        <Select
          onValueChange={(v) => {
            if (v === "cancel") {
              if (confirm("Cancel this follow-up?")) run(() => cancelFollowUpAction(r.id), "Cancelled.");
              return;
            }
            run(() => snoozeFollowUpAction(r.id, plusDays(Number(v))), "Snoozed.");
          }}
          value=""
        >
          <SelectTrigger className="h-9 w-9 justify-center border-0 bg-transparent p-0 shadow-none hover:bg-muted [&>svg:last-child]:hidden" aria-label="Snooze">
            <AlarmClock className="size-4 text-mist-400" strokeWidth={1.75} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="1">Tomorrow</SelectItem>
            <SelectItem value="3">In 3 days</SelectItem>
            <SelectItem value="7">In a week</SelectItem>
            <SelectItem value="cancel">Cancel follow-up</SelectItem>
          </SelectContent>
        </Select>

        {/* Done with outcome */}
        {outcomeOpen ? (
          <Select
            open
            onOpenChange={(o) => !o && setOutcomeOpen(false)}
            onValueChange={(v) => {
              setOutcomeOpen(false);
              run(() => completeFollowUpAction(r.id, v as FollowUpOutcome), "Done.");
            }}
            value=""
          >
            <SelectTrigger className="h-9 w-9 justify-center border-0 bg-transparent p-0 shadow-none [&>svg:last-child]:hidden" aria-label="Outcome">
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
          <button type="button" onClick={() => setOutcomeOpen(true)} disabled={pending} title="Done" aria-label="Done" className={cn(iconBtn, "text-success")}>
            <Check className="size-4" strokeWidth={2} />
          </button>
        )}

        <Link href={`/leads/${r.leadId}`} title="Open lead" aria-label="Open lead" className={cn(iconBtn, "text-mist-400")}>
          <ExternalLink className="size-4" strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  );
}
