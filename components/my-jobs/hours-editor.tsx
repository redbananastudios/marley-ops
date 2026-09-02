"use client";

/**
 * Crew daily hours + expenses editor. Phone-first, after-the-fact: tap a day,
 * enter start/finish, add a repayable expense with its receipt photo. Days can
 * be filled in any order up to the moment the week's invoice is submitted —
 * deliberately not a punch clock, and deliberately forgiving of "I'll do the
 * whole week on Friday".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Check, CircleAlert, Loader2, ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import { entryHours, timesLabel } from "@/lib/staff/time-entries";
import { uploadToMediaTarget } from "@/lib/storage/tus-upload";
import {
  clearMyTimeEntryAction,
  createReceiptUploadTargetAction,
  recordReceiptAction,
  upsertMyTimeEntryAction,
  type TimeEntryDto,
} from "@/app/my-jobs/hours/actions";

export interface HoursWeek {
  start: string; // Monday, yyyy-mm-dd
  end: string; // Sunday
  label: string; // "This week" / "Last week"
  lockedRef: string | null; // invoice ref once submitted/paid
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso: string, style: "short" | "long"): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const weekday = d.toLocaleDateString("en-GB", { weekday: style === "long" ? "long" : "short", timeZone: "UTC" });
  return `${weekday} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const gbp = (n: number): string => "£" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** ~2000px JPEG downscale so a 12MP receipt shot doesn't eat the data plan
 *  (same approach as the job-media capture sheet). HEIC that won't decode in
 *  this browser falls through to the original file — the 10MB cap backstops. */
async function downscaleReceipt(file: File): Promise<{ blob: Blob; mime: string; ext: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob) return { blob, mime: "image/jpeg", ext: "jpg" };
  } catch {
    /* fall through to the original */
  }
  const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
  const safeExt = ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext) ? ext : "jpg";
  return { blob: file, mime: file.type || "image/jpeg", ext: safeExt };
}

/** Today in UK, computed CLIENT-side at render — an installed PWA can sit open
 *  for days, and a server-rendered "today" gone stale would disable the actual
 *  today as "future". The server actions still enforce the real bounds. */
function ukToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

export function HoursEditor({
  initialEntries,
  today: serverToday,
  weeks,
  jobByDate,
}: {
  initialEntries: TimeEntryDto[];
  today: string;
  weeks: HoursWeek[];
  jobByDate: Record<string, string>;
}) {
  const [entries, setEntries] = useState<Map<string, TimeEntryDto>>(
    () => new Map(initialEntries.map((e) => [e.work_date, e])),
  );
  const [sheetDate, setSheetDate] = useState<string | null>(null);
  // Server value first (identical markup on hydration); a minute-tick keeps it
  // honest in a PWA left open across midnight. Functional update returns the
  // same reference when unchanged, so the tick is render-free 1,439 times a day.
  const [today, setToday] = useState(serverToday);
  useEffect(() => {
    const t = setInterval(() => setToday((prev) => (ukToday() === prev ? prev : ukToday())), 60_000);
    return () => clearInterval(t);
  }, []);

  const weekDays = useMemo(
    () => weeks.map((w) => ({ ...w, days: Array.from({ length: 7 }, (_, i) => addDays(w.start, i)) })),
    [weeks],
  );

  const sheetLocked = sheetDate ? (weeks.find((w) => sheetDate >= w.start && sheetDate <= w.end)?.lockedRef ?? null) : null;

  return (
    <div className="space-y-6">
      {weekDays.map((week) => {
        const logged = week.days
          .map((d) => entries.get(d))
          .filter((e): e is TimeEntryDto => !!e);
        const totalHours = logged.reduce((s, e) => s + (entryHours(e.started_at, e.ended_at) ?? 0), 0);
        const totalExpenses = logged.reduce((s, e) => s + (e.expense_amount ?? 0), 0);
        // One emptiness verdict for the whole line — hours and expenses tested
        // apart once produced "Nothing logged yet · £4.20 expenses".
        const summaryParts = [
          totalHours > 0 ? `${+totalHours.toFixed(2)} hrs` : null,
          totalExpenses > 0 ? `${gbp(totalExpenses)} expenses` : null,
        ].filter((p): p is string => p != null);
        return (
          <section key={week.start} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">{week.label}</h2>
              <span className="text-xs text-mist-400 tabular">
                {summaryParts.length > 0 ? summaryParts.join(" · ") : "Nothing logged yet"}
              </span>
            </div>
            {week.lockedRef ? (
              <p className="mt-1 text-xs text-mist-400">
                On invoice {week.lockedRef} — ask the office if something needs amending.
              </p>
            ) : null}

            <div className="mt-3 space-y-1.5">
              {week.days.map((iso) => {
                const entry = entries.get(iso);
                const hours = entry ? entryHours(entry.started_at, entry.ended_at) : null;
                const times = entry ? timesLabel(entry.started_at, entry.ended_at) : null;
                const future = iso > today;
                const disabled = future || !!week.lockedRef;
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={disabled}
                    onClick={() => setSheetDate(iso)}
                    className={cn(
                      "focus-ring flex w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors",
                      !disabled && "hover:border-mm-red/40",
                      future && "opacity-40",
                      iso === today && "ring-1 ring-inset ring-mm-red/50",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">{dayLabel(iso, "short")}</span>
                      {jobByDate[iso] ? (
                        <span className="block truncate text-xs text-mist-400">{jobByDate[iso]}</span>
                      ) : null}
                    </span>
                    {entry?.expense_amount ? (
                      <span className="flex items-center gap-1 rounded-pill bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                        <ReceiptText className="size-3" strokeWidth={2} />
                        {gbp(entry.expense_amount)}
                        {entry.has_receipt ? (
                          entry.receipt_emailed ? <Check className="size-3" strokeWidth={2.5} /> : null
                        ) : (
                          <CircleAlert className="size-3" strokeWidth={2} />
                        )}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-right">
                      {hours != null ? (
                        <>
                          <span className="block text-sm font-bold text-foreground tabular">{hours} hrs</span>
                          <span className="block text-[11px] text-mist-400 tabular">{times}</span>
                        </>
                      ) : entry?.started_at || entry?.ended_at ? (
                        <span className="block text-xs font-medium text-warn">Unfinished</span>
                      ) : entry?.expense_amount != null || entry?.has_receipt ? (
                        // Expense-only day (a receipt can land before the hours
                        // do) — the red "Add" prompt is for untouched days only.
                        <span className="block text-xs text-mist-400">Expense only</span>
                      ) : future ? (
                        <span className="block text-xs text-mist-400">—</span>
                      ) : (
                        <span className="block text-xs font-medium text-mm-red">{week.lockedRef ? "—" : "Add"}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {sheetDate ? (
        <DaySheet
          key={sheetDate}
          iso={sheetDate}
          jobLabel={jobByDate[sheetDate] ?? null}
          entry={entries.get(sheetDate) ?? null}
          lockedRef={sheetLocked}
          onClose={() => setSheetDate(null)}
          onSaved={(entry) => {
            setEntries((m) => {
              const n = new Map(m);
              n.set(entry.work_date, entry);
              return n;
            });
          }}
          onCleared={(iso) => {
            setEntries((m) => {
              const n = new Map(m);
              n.delete(iso);
              return n;
            });
          }}
        />
      ) : null}
    </div>
  );
}

function DaySheet({
  iso,
  jobLabel,
  entry,
  lockedRef,
  onClose,
  onSaved,
  onCleared,
}: {
  iso: string;
  jobLabel: string | null;
  entry: TimeEntryDto | null;
  lockedRef: string | null;
  onClose: () => void;
  onSaved: (entry: TimeEntryDto) => void;
  onCleared: (iso: string) => void;
}) {
  const [start, setStart] = useState(entry?.started_at?.slice(0, 5) ?? "");
  const [end, setEnd] = useState(entry?.ended_at?.slice(0, 5) ?? "");
  const [amount, setAmount] = useState(entry?.expense_amount != null ? String(entry.expense_amount) : "");
  const [note, setNote] = useState(entry?.expense_note ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [receiptState, setReceiptState] = useState<{ has: boolean; emailed: boolean }>({
    has: entry?.has_receipt ?? false,
    emailed: entry?.receipt_emailed ?? false,
  });
  const fileRef = useRef<HTMLInputElement>(null);

  const hours = entryHours(start || null, end || null);
  const badPair = !!start && !!end && hours == null;

  async function save() {
    if (saving || lockedRef) return;
    if (badPair) {
      toast.error("The finish time must be after the start. Work past midnight? Log it as two days.");
      return;
    }
    setSaving(true);
    try {
      const r = await upsertMyTimeEntryAction({
        work_date: iso,
        started_at: start,
        ended_at: end,
        expense_amount: amount === "" ? "" : Number(amount),
        expense_note: note,
      });
      if (r.ok) {
        onSaved(r.entry);
        onClose();
      } else {
        toast.error(r.error);
      }
    } catch {
      toast.error("Couldn’t save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function clearDay() {
    if (saving || lockedRef) return;
    // Clearing also discards the day's receipt photo — that deserves a pause.
    if (!window.confirm(`Clear ${dayLabel(iso, "long")}? This removes the day's hours, expense and receipt photo.`)) {
      return;
    }
    setSaving(true);
    try {
      const r = await clearMyTimeEntryAction({ work_date: iso });
      if (r.ok) {
        onCleared(iso);
        onClose();
      } else {
        toast.error(r.error);
      }
    } catch {
      toast.error("Couldn’t clear it — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function pickReceipt(file: File) {
    if (uploading != null || lockedRef) return;
    setUploading(0);
    try {
      // Save whatever's typed FIRST so the emailed copy carries the amount.
      const saved = await upsertMyTimeEntryAction({
        work_date: iso,
        started_at: start,
        ended_at: end,
        expense_amount: amount === "" ? "" : Number(amount),
        expense_note: note,
      });
      if (!saved.ok) {
        toast.error(saved.error);
        return;
      }
      onSaved(saved.entry);

      const { blob, mime, ext } = await downscaleReceipt(file);
      const minted = await createReceiptUploadTargetAction({
        work_date: iso,
        ext: ext as "jpg",
        mime,
        bytes: blob.size,
      });
      if (!minted.ok) {
        toast.error(minted.error);
        return;
      }
      await uploadToMediaTarget({
        target: minted.target,
        file: blob,
        onProgress: (pct) => setUploading(Math.round(pct)),
      });
      const recorded = await recordReceiptAction({ work_date: iso, path: minted.path });
      if (!recorded.ok) {
        toast.error(recorded.error);
        return;
      }
      setReceiptState({ has: true, emailed: recorded.emailed });
      onSaved({ ...saved.entry, has_receipt: true, receipt_emailed: recorded.emailed });
      toast.success(
        recorded.emailed
          ? "Receipt sent to accounts."
          : "Receipt saved — we’ll keep trying to email it to accounts.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed — try again.");
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dayLabel(iso, "long")}
        className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-card p-4 pb-6 shadow-[0_-12px_40px_-18px_rgba(0,0,0,0.5)]"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
        <h3 className="font-display text-xl font-semibold text-foreground">{dayLabel(iso, "long")}</h3>
        <p className="mt-0.5 text-sm text-mist-400">
          {lockedRef
            ? `Already on invoice ${lockedRef} — ask the office if something needs amending.`
            : (jobLabel ?? "What hours did you do, door to door?")}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-mist-400">Start</span>
            <input
              type="time"
              value={start}
              disabled={!!lockedRef}
              onChange={(e) => setStart(e.target.value)}
              className="focus-ring mt-1 block h-12 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground tabular"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-mist-400">Finish</span>
            <input
              type="time"
              value={end}
              disabled={!!lockedRef}
              onChange={(e) => setEnd(e.target.value)}
              className="focus-ring mt-1 block h-12 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground tabular"
            />
          </label>
        </div>
        <p className={cn("mt-1.5 text-sm", badPair ? "text-danger" : "text-mist-400")}>
          {badPair
            ? "Finish must be after the start — log work past midnight as two days."
            : hours != null
              ? `That’s ${hours} hours.`
              : "Full hours as they happened — lunch included."}
        </p>

        <div className="mt-4 rounded-lg border border-border bg-background p-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-mist-400">
            Expenses to pay back (optional)
          </span>
          <div className="mt-2 grid grid-cols-[110px_1fr] gap-2.5">
            <label className="block">
              <span className="sr-only">Amount</span>
              <div className="flex h-12 items-center rounded-lg border border-input bg-card px-3">
                <span className="mr-1 text-mist-400">£</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  disabled={!!lockedRef}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-transparent text-base text-foreground outline-none tabular"
                />
              </div>
            </label>
            <label className="block">
              <span className="sr-only">What it was</span>
              <input
                type="text"
                placeholder="Fuel, parking…"
                maxLength={200}
                value={note}
                disabled={!!lockedRef}
                onChange={(e) => setNote(e.target.value)}
                className="focus-ring h-12 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground"
              />
            </label>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickReceipt(f);
            }}
          />
          <button
            type="button"
            disabled={uploading != null || !!lockedRef}
            onClick={() => fileRef.current?.click()}
            className="focus-ring mt-2.5 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-input bg-card text-sm font-semibold text-foreground hover:bg-muted"
          >
            {uploading != null ? (
              <>
                <Loader2 className="size-4 animate-spin" strokeWidth={2} />
                Sending… {uploading}%
              </>
            ) : receiptState.has ? (
              <>
                <Camera className="size-4" strokeWidth={1.75} />
                {receiptState.emailed ? "Receipt sent to accounts — replace it" : "Receipt saved — replace it"}
              </>
            ) : (
              <>
                <Camera className="size-4" strokeWidth={1.75} />
                Photo of the receipt
              </>
            )}
          </button>
          <p className="mt-1.5 text-xs text-mist-400">
            The photo goes straight to accounts — the repayment lands on your weekly invoice.
          </p>
        </div>

        <div className="mt-4 space-y-2.5">
          {!lockedRef ? (
            <button
              type="button"
              disabled={saving || uploading != null}
              onClick={save}
              className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-mm-red text-[15px] font-semibold text-white transition-colors hover:bg-mm-red-deep disabled:opacity-60"
            >
              {saving ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : null}
              Save
            </button>
          ) : null}
          {entry && !lockedRef ? (
            <button
              type="button"
              disabled={saving || uploading != null}
              onClick={clearDay}
              className="focus-ring flex min-h-14 w-full items-center justify-center rounded-xl text-[15px] font-semibold text-mist-500 transition-colors hover:bg-muted"
            >
              Clear this day
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex min-h-14 w-full items-center justify-center rounded-xl border border-input bg-card text-[15px] font-semibold text-foreground transition-colors hover:bg-muted"
          >
            {lockedRef ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
