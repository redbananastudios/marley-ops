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
  ReceiptText,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommsDialog } from "@/components/comms/comms-dialog";
import { templateForReason } from "@/lib/comms/templates";
import { followUpLabel } from "@/lib/follow-ups/labels";
import { SNOOZE_OPTIONS, snoozeUntil } from "@/lib/follow-ups/snooze";
import {
  logNoReplyAction,
  completeFollowUpAction,
  snoozeFollowUpAction,
  cancelFollowUpAction,
  recordCreditNoteAction,
  type FollowUpOutcome,
} from "@/app/(dashboard)/follow-ups/actions";

export interface FollowUpRow {
  id: string;
  leadId: string;
  /** Brand slug from the lead join (multi-brand PRD §4 Follow-ups); null when
   *  the lead record is missing. */
  brand: string | null;
  reason: string;
  /** Free-text discriminator — decides the chip for reason='custom' rows. */
  source: string | null;
  /** metadata.kind, where one source carries more than one kind of job. */
  kind: string | null;
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

export function FollowUpsQueue({
  rows,
  brands = [],
  showBrandChips = false,
}: {
  rows: FollowUpRow[];
  /** Active brands (multi-brand PRD §4) — chip data. Empty or single-entry →
   *  no brand UI renders (the single-brand invariant, PRD §1). */
  brands?: BrandChipData[];
  /** True only in multi-brand mode with the ?brand= filter on All — the chip
   *  is hidden when the segmented control already names a single brand. */
  showBrandChips?: boolean;
}) {
  const brandBySlug = useMemo(() => new Map(brands.map((b) => [b.slug, b])), [brands]);
  const chipFor = (r: FollowUpRow): BrandChipData | null =>
    showBrandChips && r.brand ? (brandBySlug.get(r.brand) ?? null) : null;

  const groups = useMemo(() => {
    const cmp = (a: FollowUpRow, b: FollowUpRow) => {
      // Rank by what the card actually SAYS it is, so a bounced address sorts
      // with the urgent work rather than with the generic customs.
      const r = followUpLabel(a.reason, a.source).rank - followUpLabel(b.reason, b.source).rank;
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
      <Section title="Overdue" tone="danger" rows={groups.overdue} chipFor={chipFor} />
      <Section title="Due today" tone="normal" rows={groups.today} chipFor={chipFor} />
      <Section title="Upcoming" tone="muted" rows={groups.upcoming} chipFor={chipFor} />
    </div>
  );
}

function Section({
  title,
  tone,
  rows,
  chipFor,
}: {
  title: string;
  tone: "danger" | "normal" | "muted";
  rows: FollowUpRow[];
  chipFor: (r: FollowUpRow) => BrandChipData | null;
}) {
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
          <FollowUpCard key={r.id} r={r} chip={chipFor(r)} />
        ))}
      </div>
    </section>
  );
}

function FollowUpCard({ r, chip }: { r: FollowUpRow; chip: BrandChipData | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const meta = followUpLabel(r.reason, r.source);
  const overdue = new Date(r.dueAt).getTime() < startOfToday();
  // A credit-note task can only be finished by recording the Zoho number, which
  // also fills card_payments.zoho_credit_note_number — a bare "Done" would close
  // the card and leave the books and the app disagreeing.
  const isCreditNote = r.reason === "custom" && r.source === "card_payment" && r.kind === "credit_note";
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
          {/* Brand chip beside the reason-tone chip (multi-brand PRD §4
              Follow-ups) — 16px for this tight header line. Wrapper only
              exists when a chip renders, so single-brand markup is unchanged
              (the single-brand invariant, PRD §1). */}
          {chip ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <BrandChip brand={chip} size={16} />
              <span className={cn("shrink-0 rounded-pill px-2 py-0.5 text-xs font-medium", meta.cls)}>{meta.label}</span>
            </span>
          ) : (
            <span className={cn("shrink-0 rounded-pill px-2 py-0.5 text-xs font-medium", meta.cls)}>{meta.label}</span>
          )}
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

        {/* Snooze. DropdownMenu, not Select: these are action menus with no
            persisted value, and a Select bound to value="" never resolves a
            selected item, so Radix's item-aligned positioning silently skips its
            offset maths and the panel lands at the top-left of the viewport. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Snooze"
            disabled={pending}
            className="focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          >
            <AlarmClock className="size-4 text-mist-400" strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {SNOOZE_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={o.value}
                onSelect={() => run(() => snoozeFollowUpAction(r.id, snoozeUntil(o.value)), "Snoozed.")}
              >
                {o.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                if (confirm("Cancel this follow-up?")) run(() => cancelFollowUpAction(r.id), "Cancelled.");
              }}
            >
              Cancel follow-up
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* A credit note is finished by recording its number, not by ticking. */}
        {isCreditNote ? (
          <button
            type="button"
            disabled={pending}
            title="Record the Zoho credit note number"
            onClick={() => {
              const ref = prompt("Zoho credit note number for this refund:")?.trim();
              if (ref) run(() => recordCreditNoteAction(r.id, ref), `Credit note ${ref} recorded.`);
            }}
            className={cn(iconBtn, "text-success")}
          >
            <ReceiptText className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}

        {/* Done with outcome — same primitive, same reason. */}
        {outcomeOpen ? (
          <DropdownMenu open onOpenChange={(o) => !o && setOutcomeOpen(false)}>
            <DropdownMenuTrigger
              aria-label="Outcome"
              className="focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            >
              <Check className="size-4 text-success" strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {OUTCOMES.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onSelect={() => {
                    setOutcomeOpen(false);
                    run(() => completeFollowUpAction(r.id, o.value), "Done.");
                  }}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
