"use client";

/**
 * Office view of crew payment statements (Finance › Crew pay). Submitted
 * statements are the ones needing action — expand to see the lines, then mark
 * paid (BACS / cash), RETURN to the crew for a fix, or void a mistake.
 * Everything is downloadable as the branded no-VAT PDF. Self-billing hinges on
 * the crew confirming their own pay, so we never silently edit their lines — a
 * correction goes back to them via Return.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, CornerUpLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { periodLabel } from "@/lib/staff/statements";
import { StatementPdfButton } from "@/components/my-jobs/statement-pdf-button";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";
import {
  markStatementPaidAction,
  returnStatementToCrewAction,
  voidStatementAction,
} from "@/app/(dashboard)/finance/statements/actions";

export interface OfficeStatement {
  id: string;
  ref: string;
  staffName: string;
  status: string;
  period_start: string;
  period_end: string;
  total: number;
  paid_method: string | null;
  paid_ref: string | null;
  pdf: StatementPdfData;
}

const gbp = (n: number): string => "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const dayLabel = (iso: string | null): string | null =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
const STATUS_META: Record<string, string> = {
  draft: "bg-muted text-mist-500",
  submitted: "bg-survey-bg text-survey-deep",
  paid: "bg-success-bg text-success",
  void: "bg-muted text-mist-400 line-through",
};

type Filter = "submitted" | "paid" | "all";

export function OfficeStatementsView({ statements, enabled }: { statements: OfficeStatement[]; enabled: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("submitted");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [payFor, setPayFor] = useState<OfficeStatement | null>(null);
  const [returnFor, setReturnFor] = useState<OfficeStatement | null>(null);

  const counts = useMemo(
    () => ({
      submitted: statements.filter((s) => s.status === "submitted").length,
      paid: statements.filter((s) => s.status === "paid").length,
      all: statements.length,
    }),
    [statements],
  );
  const toPayTotal = useMemo(
    () => statements.filter((s) => s.status === "submitted").reduce((sum, s) => sum + Number(s.total), 0),
    [statements],
  );
  const shown = statements.filter((s) => (filter === "all" ? true : s.status === filter));

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function doVoid(s: OfficeStatement) {
    if (!confirm(`Void ${s.ref} for ${s.staffName}? This can't be undone.`)) return;
    setBusy(`void-${s.id}`);
    const r = await voidStatementAction({ id: s.id });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success("Statement voided.");
    router.refresh();
  }

  return (
    <div>
      {!enabled ? (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3 text-sm text-warn">
          Self-billing is switched off — crew can&apos;t build new statements. Turn it on in Settings › Self-billing once
          the agreement is signed.
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex rounded-lg border border-border bg-card p-1 text-sm">
          {(["submitted", "paid", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 font-medium capitalize transition-colors",
                filter === f ? "bg-mm-red text-white" : "text-mist-500 hover:text-foreground",
              )}
            >
              {f === "submitted" ? "To pay" : f}
              <span className={cn("ml-1.5 text-xs", filter === f ? "text-white/80" : "text-mist-400")}>{counts[f]}</span>
            </button>
          ))}
        </div>
        {counts.submitted > 0 ? (
          <p className="text-sm text-mist-500">
            <span className="font-semibold text-foreground">{gbp(toPayTotal)}</span> to pay across {counts.submitted}{" "}
            {counts.submitted === 1 ? "statement" : "statements"}
          </p>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-5 py-12 text-center text-sm text-mist-500">
          {filter === "submitted" ? "Nothing waiting to be paid." : "No statements here yet."}
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((s) => {
            const isOpen = expanded.has(s.id);
            return (
              <div key={s.id} className="rounded-lg border border-border bg-card">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    aria-expanded={isOpen}
                    className="focus-ring -my-1 flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left"
                  >
                    <ChevronRight
                      className={cn("size-4 shrink-0 text-mist-400 transition-transform", isOpen && "rotate-90")}
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">{s.staffName}</span>
                      <span className="block text-xs text-mist-400">
                        {periodLabel(s.period_start, s.period_end)} · Ref {s.ref}
                        {s.status === "paid" && s.paid_method ? ` · paid ${s.paid_method}${s.paid_ref ? ` (${s.paid_ref})` : ""}` : ""}
                      </span>
                    </span>
                  </button>
                  <span className="text-sm font-semibold tabular text-foreground">{gbp(s.total)}</span>
                  <span className={cn("rounded-pill px-2.5 py-1 text-[11px] font-semibold capitalize", STATUS_META[s.status] ?? "bg-muted text-mist-500")}>
                    {s.status}
                  </span>
                  <div className="flex items-center gap-2">
                    <StatementPdfButton data={s.pdf} />
                    {s.status === "submitted" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setReturnFor(s)}
                          className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 hover:bg-muted"
                        >
                          <CornerUpLeft className="size-4" strokeWidth={1.75} />
                          Return
                        </button>
                        <button
                          type="button"
                          onClick={() => setPayFor(s)}
                          className="focus-ring inline-flex min-h-11 items-center rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep"
                        >
                          Mark paid
                        </button>
                        <button
                          type="button"
                          disabled={busy === `void-${s.id}`}
                          onClick={() => doVoid(s)}
                          className="focus-ring inline-flex min-h-11 items-center rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 hover:bg-muted disabled:opacity-50"
                        >
                          {busy === `void-${s.id}` ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : "Void"}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                {isOpen ? (
                  <div className="border-t border-border px-4 py-3">
                    {s.pdf.lines.length === 0 ? (
                      <p className="text-sm text-mist-400">No lines on this statement.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {s.pdf.lines.map((l, i) => (
                          <li key={i} className="flex items-baseline gap-3 text-sm">
                            <span className="min-w-0 flex-1">
                              <span className="text-foreground">{l.description}</span>
                              {(() => {
                                const meta = [
                                  dayLabel(l.work_date),
                                  l.quantity != null && l.unit_amount != null ? `${l.quantity} × ${gbp(l.unit_amount)}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ");
                                return meta ? <span className="ml-2 text-xs text-mist-400">{meta}</span> : null;
                              })()}
                            </span>
                            <span className="shrink-0 tabular text-foreground">{gbp(l.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.pdf.note ? (
                      <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-mist-500">
                        <span className="font-semibold text-mist-400">Crew note:</span> {s.pdf.note}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {payFor ? <PayDialog statement={payFor} onClose={() => setPayFor(null)} onPaid={() => { setPayFor(null); router.refresh(); }} /> : null}
      {returnFor ? (
        <ReturnDialog
          statement={returnFor}
          onClose={() => setReturnFor(null)}
          onReturned={() => {
            setReturnFor(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function ReturnDialog({
  statement,
  onClose,
  onReturned,
}: {
  statement: OfficeStatement;
  onClose: () => void;
  onReturned: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      toast.error("Give the crew a reason.");
      return;
    }
    setBusy(true);
    const r = await returnStatementToCrewAction({ id: statement.id, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`Returned to ${statement.staffName}.`);
    onReturned();
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div className="absolute left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">{statement.staffName}</p>
        <h3 className="mt-0.5 font-display text-xl font-semibold text-foreground">Return {statement.ref} for changes</h3>
        <p className="mt-1 text-sm text-mist-400">
          This hands the statement back so {statement.staffName.split(" ")[0]} can fix it and re-submit — they confirm their
          own pay. Tell them what needs changing.
        </p>

        <label className="mt-4 block text-xs font-medium text-mist-500">Reason</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Sat 19th was a survey not a full day — please amend."
          className="focus-ring mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
        />

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring min-h-11 flex-1 rounded-md border border-input bg-card text-sm font-medium text-foreground hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="focus-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-mm-red text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <CornerUpLeft className="size-4" strokeWidth={1.75} />}
            Return to crew
          </button>
        </div>
      </div>
    </div>
  );
}

function PayDialog({
  statement,
  onClose,
  onPaid,
}: {
  statement: OfficeStatement;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [method, setMethod] = useState<"bacs" | "cash" | "other">("bacs");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    const r = await markStatementPaidAction({ id: statement.id, method, ref });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`Marked paid — ${statement.ref}.`);
    onPaid();
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div className="absolute left-1/2 top-1/2 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">{statement.staffName}</p>
        <h3 className="mt-0.5 font-display text-xl font-semibold text-foreground">Mark {statement.ref} paid</h3>
        <p className="mt-0.5 text-sm text-mist-400">
          {gbp(statement.total)} · {periodLabel(statement.period_start, statement.period_end)}
        </p>

        <label className="mt-4 block text-xs font-medium text-mist-500">How was it paid?</label>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {(["bacs", "cash", "other"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={cn(
                "focus-ring min-h-11 rounded-md border text-sm font-semibold uppercase transition-colors",
                method === m ? "border-mm-red bg-mm-red text-white" : "border-input bg-card text-mist-500 hover:bg-muted",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-xs font-medium text-mist-500">Payment reference (optional)</label>
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="Bank ref, receipt no…"
          className="focus-ring mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
        />

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring min-h-11 flex-1 rounded-md border border-input bg-card text-sm font-medium text-foreground hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={pay}
            className="focus-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-mm-red text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Mark paid
          </button>
        </div>
      </div>
    </div>
  );
}
