"use client";

/**
 * Manage a let — one dialog for the three storage phase-2 concerns:
 *  Agreement  signed state, in-person signing (default), remote link (option)
 *  Billing    raised invoices + status, next invoice date, pause toggle
 *  Details    rate / period / start date / notes (anchors lock once invoiced)
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, FileDown, Loader2, Pause, PenLine, Play } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/signature-pad";
import { STORAGE_ACKS, type StorageAckKey } from "@/lib/signatures";
import {
  editLetAction,
  getStorageSignLinkAction,
  setBillingPausedAction,
  signStorageAgreementAction,
} from "@/app/(dashboard)/storage/actions";
import type { LetRow, UnitRow } from "@/components/storage/storage-view";

const NONE: Record<StorageAckKey, boolean> = { rate_advance: false, lien: false, no_prohibited: false };

const gbp = (n: number): string => "£" + Number(n).toFixed(2).replace(/\.00$/, "");

const fmtDay = (d: string | null): string =>
  d
    ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

const INV_STATUS: Record<string, string> = {
  pending: "bg-muted text-mist-500",
  sent: "bg-warn-bg text-warn",
  paid: "bg-success-bg text-success",
  void: "bg-mist-100 text-mist-400",
  error: "bg-danger-bg text-danger",
};

export function ManageLetDialog({ unit, let_, onClose }: { unit: UnitRow; let_: LetRow; onClose: () => void }) {
  const router = useRouter();
  const [signing, setSigning] = useState(false);
  const [acks, setAcks] = useState(NONE);
  const [signerName, setSignerName] = useState(let_.client_name);
  const [sig, setSig] = useState<string | null>(null);
  const [rate, setRate] = useState(let_.rate == null ? "" : String(let_.rate));
  const [period, setPeriod] = useState(let_.rate_period);
  const [startDate, setStartDate] = useState(let_.start_date.slice(0, 10));
  const [notes, setNotes] = useState(let_.notes ?? "");
  const [pending, start] = useTransition();

  const signReady = STORAGE_ACKS.every((a) => acks[a.key]) && !!sig && signerName.trim().length >= 2;

  function signNow() {
    start(async () => {
      const res = await signStorageAgreementAction(let_.id, {
        signerName: signerName.trim(),
        signatureDataUri: sig!,
        acks,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Storage agreement signed.");
      setSigning(false);
      router.refresh();
    });
  }

  function copyLink() {
    start(async () => {
      const res = await getStorageSignLinkAction(let_.id);
      if (!res.ok) return void toast.error(res.error);
      try {
        await navigator.clipboard.writeText(res.url);
        toast.success("Signing link copied — send it to the customer.");
      } catch {
        toast.info(res.url); // clipboard blocked — show it instead
      }
    });
  }

  function togglePause() {
    start(async () => {
      const res = await setBillingPausedAction(let_.id, !let_.billing_paused);
      if (!res.ok) return void toast.error(res.error);
      toast.success(let_.billing_paused ? "Billing resumed." : "Billing paused — no new invoices until resumed.");
      router.refresh();
    });
  }

  function saveDetails() {
    start(async () => {
      const res = await editLetAction(let_.id, {
        rate: rate === "" ? "" : Number(rate),
        rate_period: period as "week" | "month",
        start_date: startDate,
        notes,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Let updated — future invoices use the new details.");
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {unit.code || unit.name || "Unit"} — {let_.client_name}
          </DialogTitle>
          <DialogDescription>
            Since {fmtDay(let_.start_date)}
            {let_.rate != null ? ` · ${gbp(let_.rate)}/${let_.rate_period === "month" ? "month" : "week"}` : " · unpriced"}
          </DialogDescription>
        </DialogHeader>

        {/* ---- agreement ---- */}
        <section className="rounded-md border border-border p-4">
          <p className="eyebrow mb-2">Storage agreement</p>
          {let_.agreement ? (
            <p className="text-sm text-success">
              Signed {let_.agreement.channel === "in_person" ? "in person" : "online"} by{" "}
              <strong>{let_.agreement.signer}</strong> — it&apos;s in Documents.
            </p>
          ) : signing ? (
            <div className="space-y-3">
              {STORAGE_ACKS.map((a) => (
                <label
                  key={a.key}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red-tint/30"
                >
                  <input
                    type="checkbox"
                    checked={acks[a.key]}
                    onChange={(e) => setAcks((s) => ({ ...s, [a.key]: e.target.checked }))}
                    className="size-5 shrink-0 accent-mm-red"
                  />
                  <span className="text-sm leading-snug text-foreground">{a.label}</span>
                </label>
              ))}
              <div>
                <label htmlFor="signer" className="eyebrow mb-1.5 block">
                  Customer&apos;s full name
                </label>
                <input
                  id="signer"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  className="focus-ring h-12 w-full rounded-md border border-input bg-card px-3 text-base"
                />
              </div>
              <div>
                <p className="eyebrow mb-1.5">Customer&apos;s signature</p>
                <SignaturePad onChange={setSig} label="Customer signs here" />
              </div>
              <div className="flex gap-2">
                <Button onClick={signNow} disabled={pending || !signReady} className="bg-mm-red text-white hover:bg-mm-red-deep">
                  {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
                  Save signature
                </Button>
                <Button variant="outline" onClick={() => setSigning(false)} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-pill border border-warn-border bg-warn-bg px-2.5 py-1 text-[11px] font-semibold text-warn">
                Not signed yet
              </span>
              <Button size="sm" onClick={() => setSigning(true)} className="bg-mm-red text-white hover:bg-mm-red-deep">
                <PenLine className="size-4" strokeWidth={1.75} />
                Sign now
              </Button>
              <Button size="sm" variant="outline" onClick={copyLink} disabled={pending}>
                <Copy className="size-4" strokeWidth={1.75} />
                Copy signing link
              </Button>
            </div>
          )}
        </section>

        {/* ---- billing ---- */}
        <section className="rounded-md border border-border p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="eyebrow">Billing</p>
            <Button size="sm" variant="outline" onClick={togglePause} disabled={pending}>
              {let_.billing_paused ? <Play className="size-4" strokeWidth={1.75} /> : <Pause className="size-4" strokeWidth={1.75} />}
              {let_.billing_paused ? "Resume billing" : "Pause billing"}
            </Button>
          </div>
          {let_.rate == null || Number(let_.rate) <= 0 ? (
            <p className="text-sm text-warn">No rate set — nothing bills until a rate is saved below.</p>
          ) : let_.billing_paused ? (
            <p className="text-sm text-warn">Billing paused — no new invoices until resumed.</p>
          ) : let_.next_invoice ? (
            <p className="text-sm text-mist-500">
              Next invoice <strong className="text-foreground">{fmtDay(let_.next_invoice)}</strong> (raised
              automatically each morning).
            </p>
          ) : null}
          {let_.invoices.length ? (
            <ul className="mt-2 divide-y border-t">
              {let_.invoices.map((inv) => (
                <li key={inv.id} className="flex items-center gap-2 py-2 text-sm">
                  <span className="tabular min-w-0 flex-1 truncate text-foreground">
                    {fmtDay(inv.period_start)} · {gbp(inv.amount)}
                    {inv.zoho_invoice_number ? ` · ${inv.zoho_invoice_number}` : ""}
                  </span>
                  <span className={cn("rounded-pill px-2 py-0.5 text-[11px] font-semibold capitalize", INV_STATUS[inv.status] ?? INV_STATUS.pending)}>
                    {inv.status}
                  </span>
                  {inv.zoho_invoice_url ? (
                    <a
                      href={inv.zoho_invoice_url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open invoice"
                      className="focus-ring flex size-8 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
                    >
                      <FileDown className="size-4" strokeWidth={1.75} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-mist-400">No invoices raised yet.</p>
          )}
        </section>

        {/* ---- details ---- */}
        <section className="rounded-md border border-border p-4">
          <p className="eyebrow mb-2">Let details</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="let-rate" className="eyebrow mb-1.5 block">
                Rate (£)
              </label>
              <input
                id="let-rate"
                type="number"
                min="0"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="let-period" className="eyebrow mb-1.5 block">
                Per
              </label>
              <select
                id="let-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>
            <div>
              <label htmlFor="let-start" className="eyebrow mb-1.5 block">
                Start date
              </label>
              <input
                id="let-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label htmlFor="let-notes" className="eyebrow mb-1.5 block">
                Notes
              </label>
              <textarea
                id="let-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={saveDetails} disabled={pending} className="bg-mm-red text-white hover:bg-mm-red-deep">
              {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Save details
            </Button>
          </div>
          {let_.invoices.length ? (
            <p className="mt-2 text-xs text-mist-400">
              Invoices exist, so the start date and billing period are locked — rate and notes still change.
            </p>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}
