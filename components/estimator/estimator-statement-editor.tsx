"use client";

/**
 * Estimator contractor-invoice editor. Unlike the crew editor (hours × rate),
 * an estimator's lines are FIXED FEES — survey visits (£50), telephone quotes
 * (£10) and completion commission (7.5% of the ex-VAT job value). "Add my work
 * this week" pulls them in; the estimator reviews, can remove a line or add a
 * hand-entered adjustment, then submits — their own confirm (the IR35-safe act
 * of invoicing). No VAT (not VAT-registered), no weekly guarantee (crew only).
 */

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { periodLabel, type StatementStatus } from "@/lib/staff/statements";
import { StatementPdfButton } from "@/components/my-jobs/statement-pdf-button";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";
import {
  deleteMyEstimatorLineAction,
  seedMyEstimatorWorkAction,
  submitMyEstimatorStatementAction,
  upsertMyEstimatorLineAction,
} from "@/app/(dashboard)/estimator/pay/actions";

interface Line {
  id: string;
  description: string;
  work_date: string | null;
  quantity: number | null;
  unit_amount: number | null;
  amount: number;
  source: string;
}
interface StatementHead {
  id: string;
  ref: string;
  status: StatementStatus;
  period_start: string;
  period_end: string;
  total: number;
  note: string | null;
  return_reason: string | null;
}

const gbp = (n: number): string => "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const SOURCE_LABEL: Record<string, string> = {
  survey: "Survey visit fee",
  phone_quote: "Telephone quote fee",
  commission: "Completion commission",
  manual: "Added by hand",
};

export function EstimatorStatementEditor({
  statement,
  lines,
  pdfData,
}: {
  statement: StatementHead;
  lines: Line[];
  pdfData: StatementPdfData;
}) {
  const router = useRouter();
  const editable = statement.status === "draft";
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Line | "new" | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // try/catch/finally: a rejected server action (dropped signal, stale action id
  // after a deploy) must still clear busy — otherwise the buttons on a screen
  // that pays people stay disabled + spinning forever.
  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Something went wrong.");
        return false;
      }
      if (okMsg) toast.success(okMsg);
      router.refresh();
      return true;
    } catch {
      toast.error("Couldn't reach the server — check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Seeding has its own handler (not run()) so the toast reflects the count — a
  // week with genuinely no work is a normal empty state, not an error.
  async function seed() {
    setBusy("seed");
    try {
      const r = await seedMyEstimatorWorkAction({ statement_id: statement.id });
      if (!r.ok) {
        toast.error(r.error ?? "Something went wrong.");
        return;
      }
      toast.success(r.added ? `Added ${r.added} line${r.added === 1 ? "" : "s"}.` : "No new work to add for this week.");
      // Completed jobs that couldn't be commissioned (no agreed price, or a
      // duplicate-accepted anomaly) are flagged so they're never silently missed.
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 10000 });
      router.refresh();
    } catch {
      toast.error("Couldn't reach the server — check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const total = lines.reduce((s, l) => s + Number(l.amount ?? 0), 0);

  return (
    <div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{periodLabel(statement.period_start, statement.period_end)}</p>
            <p className="text-xs text-mist-400">Ref {statement.ref}</p>
          </div>
          <StatusPill status={statement.status} />
        </div>
        <div className="mt-3 flex items-end justify-between">
          <span className="text-xs uppercase tracking-wide text-mist-400">Total</span>
          <span className="font-display text-2xl font-bold tabular text-foreground">{gbp(total)}</span>
        </div>
        <p className="mt-1 text-[11px] text-mist-400">No VAT — you&apos;re not VAT registered, so this is a plain contractor invoice.</p>
      </div>

      {editable && statement.return_reason ? (
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg px-4 py-3">
          <p className="text-sm font-semibold text-warn">The office asked for a change</p>
          <p className="mt-0.5 text-sm text-warn/90">{statement.return_reason}</p>
          <p className="mt-1 text-xs text-warn/80">Fix it below, then submit again.</p>
        </div>
      ) : null}

      {editable ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={seed}
          className="focus-ring mt-4 flex w-full items-center gap-3 rounded-xl border border-dashed border-mm-red/40 bg-mm-red/5 px-4 py-3 text-left hover:bg-mm-red/10 disabled:opacity-60"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-mm-red/10 text-mm-red">
            {busy === "seed" ? <Loader2 className="size-5 animate-spin" strokeWidth={1.75} /> : <CalendarPlus className="size-5" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">Add my work this week</span>
            <span className="block text-xs text-mist-400">Survey visits, telephone quotes and commission on jobs completed this week</span>
          </span>
        </button>
      ) : null}

      <div className="mt-4 space-y-2.5">
        {lines.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-5 py-8 text-center text-sm text-mist-500">
            No lines yet.{editable ? " Add your work above, or add a line by hand." : ""}
          </div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{l.description}</p>
                <p className="text-xs text-mist-400">{SOURCE_LABEL[l.source] ?? "Line"}</p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular text-foreground">{gbp(l.amount)}</span>
              {editable ? (
                <div className="flex shrink-0 items-center">
                  {l.source === "manual" ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setSheet(l)}
                      aria-label="Edit line"
                      className="focus-ring flex size-8 items-center justify-center rounded text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <Plus className="size-4 rotate-45" strokeWidth={1.75} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => run(`del-${l.id}`, () => deleteMyEstimatorLineAction({ id: l.id, statement_id: statement.id }))}
                    aria-label="Remove line"
                    className="focus-ring flex size-8 items-center justify-center rounded text-mist-400 hover:bg-danger-bg hover:text-danger disabled:opacity-50"
                  >
                    {busy === `del-${l.id}` ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Trash2 className="size-4" strokeWidth={1.75} />}
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {editable ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => setSheet("new")}
          className="focus-ring mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-input bg-card text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
        >
          <Plus className="size-4" strokeWidth={1.75} />
          Add a line
        </button>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <StatementPdfButton data={{ ...pdfData, total }} />
        {editable ? (
          <button
            type="button"
            disabled={busy !== null || lines.length === 0}
            onClick={() => setConfirmSubmit(true)}
            className="focus-ring ml-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-50"
          >
            <Send className="size-4" strokeWidth={1.75} />
            Submit invoice
          </button>
        ) : (
          <span className="ml-auto text-sm text-mist-400">Submitted — the office will pay this and mark it off.</span>
        )}
      </div>

      {sheet ? (
        <LineSheet
          line={sheet === "new" ? null : sheet}
          statementId={statement.id}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            router.refresh();
          }}
        />
      ) : null}

      {confirmSubmit ? (
        <div className="fixed inset-0 z-50">
          <button type="button" aria-label="Close" onClick={() => setConfirmSubmit(false)} className="absolute inset-0 bg-black/45" />
          <div className="absolute left-1/2 top-1/2 w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-xl">
            <h3 className="font-display text-xl font-semibold text-foreground">Submit this invoice?</h3>
            <p className="mt-1 text-sm text-mist-400">
              You&apos;re submitting <span className="font-semibold text-foreground">{gbp(total)}</span> for{" "}
              {periodLabel(statement.period_start, statement.period_end)}. You can&apos;t edit it after this — ask the office if
              something needs changing.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmSubmit(false)}
                className="focus-ring min-h-11 flex-1 rounded-md border border-input bg-card text-sm font-medium text-foreground hover:bg-muted"
              >
                Not yet
              </button>
              <button
                type="button"
                disabled={busy === "submit"}
                onClick={async () => {
                  const ok = await run("submit", () => submitMyEstimatorStatementAction({ statement_id: statement.id }), "Invoice submitted.");
                  if (ok) setConfirmSubmit(false);
                }}
                className="focus-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-mm-red text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
              >
                {busy === "submit" ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
                Submit
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: StatementStatus }) {
  const meta: Record<StatementStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-mist-500" },
    submitted: { label: "Submitted", cls: "bg-survey-bg text-survey-deep" },
    paid: { label: "Paid", cls: "bg-success-bg text-success" },
    void: { label: "Void", cls: "bg-muted text-mist-400 line-through" },
  };
  const m = meta[status];
  return <span className={cn("rounded-pill px-2.5 py-1 text-[11px] font-semibold", m.cls)}>{m.label}</span>;
}

function LineSheet({
  line,
  statementId,
  onClose,
  onSaved,
}: {
  line: Line | null;
  statementId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(line?.description ?? "");
  const [amount, setAmount] = useState(line?.amount != null ? String(line.amount) : "");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  async function save() {
    if (!description.trim()) {
      toast.error("Add a description.");
      return;
    }
    if (amount === "" || !(Number(amount) > 0)) {
      toast.error("Enter an amount (£).");
      return;
    }
    setBusy(true);
    try {
      const r = await upsertMyEstimatorLineAction({
        id: line?.id,
        statement_id: statementId,
        description: description.trim(),
        amount: Number(amount),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onSaved();
    } catch {
      toast.error("Couldn't save — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-card p-4 pb-6 shadow-[0_-12px_40px_-18px_rgba(0,0,0,0.5)]">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
        <h3 className="font-display text-xl font-semibold text-foreground">{line ? "Edit line" : "Add a line"}</h3>

        <label htmlFor={`${fieldId}-description`} className="mt-4 block text-xs font-medium text-mist-500">
          Description
        </label>
        <input
          id={`${fieldId}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Agreed adjustment"
          className="focus-ring mt-1 h-12 w-full rounded-md border border-input bg-card px-3 text-base"
        />

        <label htmlFor={`${fieldId}-amount`} className="mt-3 block text-xs font-medium text-mist-500">
          Amount (£)
        </label>
        <input
          id={`${fieldId}-amount`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="50"
          className="focus-ring mt-1 h-12 w-full rounded-md border border-input bg-card px-3 text-base"
        />

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring min-h-12 flex-1 rounded-xl border border-input bg-card text-sm font-semibold text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="focus-ring inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-mm-red text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
