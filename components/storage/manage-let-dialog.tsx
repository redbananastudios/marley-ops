"use client";

/**
 * Manage a let — one dialog for the three storage phase-2 concerns:
 *  Agreement  signed state, in-person signing (default), remote link (option)
 *  Billing    raised invoices + status, next invoice date, pause toggle
 *  Details    rate / period / start date / notes (anchors lock once invoiced)
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, FileDown, Loader2, Mail, Pause, PenLine, Play, Plus, Trash2 } from "lucide-react";
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
import { crateMinimumLabel, crateStorageAcks, storageAcks } from "@/lib/signatures";
import { DEFAULT_BRAND } from "@/lib/brand";
import { gbpInc, type StorageRates } from "@/lib/storage-rates";
import type { BrandChipData } from "@/components/brand/brand-chip";
import {
  deleteHandlingEventAction,
  editLetAction,
  emailStorageSignLinkAction,
  getStorageSignLinkAction,
  recordHandlingEventAction,
  setBillingPausedAction,
  signStorageAgreementAction,
} from "@/app/(dashboard)/storage/actions";
import type { LetRow, UnitRow } from "@/components/storage/storage-view";

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

export function ManageLetDialog({
  unit,
  let_,
  rates,
  brands = [],
  onClose,
}: {
  unit: UnitRow;
  let_: LetRow;
  rates: StorageRates;
  /** Slim brands rows — the brand selector renders only with two or more
   *  (the single-brand invariant, multi-brand PRD §1). */
  brands?: BrandChipData[];
  onClose: () => void;
}) {
  const router = useRouter();
  const isCrate = let_.billing_model === "crate_daily";

  /* The company the lien tick-box names — the party the customer is granting
     the right to dispose of or sell their stored goods to. This is the storage
     path most agreements actually take, and it named the DEFAULT brand for
     every brand: a second brand's customer signing in front of the crew was
     granting the DEFAULT brand rights over their belongings.

     Read from `let_.brand` — the PERSISTED stamp — and deliberately NOT from
     the `brand` selector state below: the server re-derives the recorded
     wording from the stored column, so reading an unsaved dropdown here would
     render one company and record another. */
  const letBrandSlug = (let_.brand ?? "").trim();
  const letBrandRow = brands.find((b) => b.slug === letBrandSlug);
  /* Blank or the default slug resolves to the literal default company, which is
     exactly what getBrandOrDefault → pageTheme returns server-side. Anything
     else needs the row, and `brands` is empty BOTH in single-brand mode and on
     a failed brands read (the storage page uses listActiveBrandsOrEmpty) — so a
     missing row is "I could not check", not "it must be the default", while the
     server would go on to record the real name. Refuse to open the signing
     panel rather than let the two disagree. */
  const companyKnown = !letBrandSlug || letBrandSlug === DEFAULT_BRAND || !!letBrandRow;
  const signingCompanyName = letBrandRow?.name ?? null;

  // The ack set follows the product: crates sign the billing schedule (the
  // let's frozen minimum + handling figure rendered live from the rate card),
  // containers keep the original rate ack (standing policy 2026-07-22).
  const ackList = useMemo(
    () =>
      isCrate
        ? crateStorageAcks(
            { kind: let_.min_kind, days: let_.min_days ?? rates.crateMinDays },
            gbpInc(rates.handlingEventInc),
            signingCompanyName,
          )
        : [...storageAcks(signingCompanyName)],
    [isCrate, let_.min_kind, let_.min_days, rates, signingCompanyName],
  );
  const [signing, setSigning] = useState(false);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [signerName, setSignerName] = useState(let_.client_name);
  const [sig, setSig] = useState<string | null>(null);
  const [rate, setRate] = useState(let_.rate == null ? "" : String(let_.rate));
  const [period, setPeriod] = useState(let_.rate_period);
  const [startDate, setStartDate] = useState(let_.start_date.slice(0, 10));
  // Pre-filled with the stamp from creation (lead first, then site — PRD §2);
  // overridable here because attribution is all the brand does this gate.
  const [brand, setBrand] = useState(let_.brand);
  const [notes, setNotes] = useState(let_.notes ?? "");
  const [pending, start] = useTransition();

  const signReady =
    companyKnown && ackList.every((a) => acks[a.key]) && !!sig && signerName.trim().length >= 2;

  // Guard every transition against a rejected server action (dropped signal,
  // stale action id after a deploy): without the catch the rejection escapes
  // to the error boundary and the dialog reads as stuck mid-operation.
  function run(fn: () => Promise<void>) {
    start(async () => {
      try {
        await fn();
      } catch {
        toast.error("Something went wrong — check whether the change landed before retrying.");
      }
    });
  }

  function signNow() {
    run(async () => {
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
    run(async () => {
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

  function emailLink() {
    run(async () => {
      const res = await emailStorageSignLinkAction(let_.id);
      if ("duplicate" in res) return void toast.info("That signing link was already emailed to the customer.");
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Signing link emailed to ${let_.client_name}.`);
      router.refresh();
    });
  }

  function togglePause() {
    run(async () => {
      const res = await setBillingPausedAction(let_.id, !let_.billing_paused);
      if (!res.ok) return void toast.error(res.error);
      toast.success(let_.billing_paused ? "Billing resumed." : "Billing paused — no new invoices until resumed.");
      router.refresh();
    });
  }

  function saveDetails() {
    run(async () => {
      const res = await editLetAction(let_.id, {
        rate: rate === "" ? "" : Number(rate),
        rate_period: period as "week" | "month" | "day",
        start_date: startDate,
        // Only a real change travels — "" leaves the stamp untouched (and
        // sidesteps validation if the stored brand has since been retired).
        brand: brand !== let_.brand ? brand : "",
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
            {let_.rate != null
              ? ` · ${gbp(let_.rate)}/${let_.rate_period === "month" ? "month" : let_.rate_period === "day" ? "day" : "week"}`
              : " · unpriced"}
            {isCrate && let_.min_days != null && let_.min_amount != null
              ? ` · ${crateMinimumLabel(let_.min_kind, let_.min_days)} ${gbp(let_.min_amount)}`
              : ""}
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
              {ackList.map((a) => (
                <label
                  key={a.key}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red-tint/30"
                >
                  <input
                    type="checkbox"
                    checked={!!acks[a.key]}
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
            <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-pill border border-warn-border bg-warn-bg px-2.5 py-1 text-[11px] font-semibold text-warn">
                Not signed yet
              </span>
              <Button
                size="sm"
                onClick={() => setSigning(true)}
                // Fail closed: the agreement names a company, and if this let's
                // brand cannot be resolved we would show one name and record
                // another. Copying or emailing the signing link still works —
                // /s resolves the brand server-side.
                disabled={!companyKnown}
                title={
                  companyKnown
                    ? undefined
                    : "This let's brand could not be read, so the agreement wording cannot be shown"
                }
                className="bg-mm-red text-white hover:bg-mm-red-deep"
              >
                <PenLine className="size-4" strokeWidth={1.75} />
                Sign now
              </Button>
              <Button size="sm" variant="outline" onClick={copyLink} disabled={pending}>
                <Copy className="size-4" strokeWidth={1.75} />
                Copy signing link
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={emailLink}
                disabled={pending || !let_.client_email}
                title={let_.client_email ? undefined : "No email on file for this client"}
              >
                <Mail className="size-4" strokeWidth={1.75} />
                Email signing link
              </Button>
            </div>
            {!companyKnown ? (
              <p className="mt-2 text-xs text-warn">
                This let&apos;s brand could not be read, so the agreement wording cannot be shown
                here. Refresh the page and try again, or send the customer the signing link, which
                resolves the brand on the page itself.
              </p>
            ) : null}
            </>
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
          {isCrate ? (
            <p className="mb-1 text-xs text-mist-400">
              {crateMinimumLabel(let_.min_kind, let_.min_days ?? rates.crateMinDays)} billed upfront; further days
              charge to the exact day, in arrears, every 4 weeks. Handling bills per event. The final invoice settles
              before release.
            </p>
          ) : null}
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

        {/* ---- handling events (crate lets) ---- */}
        {isCrate ? <HandlingEventsSection let_={let_} rates={rates} /> : null}

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
                // Crate arrears bill retrospectively at the let's rate, so the
                // server locks the rate once any invoice exists — mirror that
                // here rather than letting an edit fail at Save.
                disabled={isCrate && let_.invoices.length > 0}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm disabled:bg-muted/60 disabled:text-mist-500"
              />
            </div>
            <div>
              <label htmlFor="let-period" className="eyebrow mb-1.5 block">
                Per
              </label>
              {isCrate ? (
                <div className="flex h-11 items-center rounded-md border border-input bg-muted/60 px-3 text-sm text-mist-500">
                  Day (crate)
                </div>
              ) : (
                <select
                  id="let-period"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
                >
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                </select>
              )}
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
            {brands.length > 1 ? (
              <div>
                <label htmlFor="let-brand" className="eyebrow mb-1.5 block">
                  Brand
                </label>
                <select
                  id="let-brand"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
                >
                  {brands.some((b) => b.slug === brand) ? null : <option value={brand}>{brand}</option>}
                  {brands.map((b) => (
                    <option key={b.slug} value={b.slug}>
                      {b.shortName ?? b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
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
              {isCrate
                ? "Invoices exist, so the start date, billing period and day rate are locked (arrears bill at the let's rate) — notes still change. For a new rate, end this let and start a new one."
                : "Invoices exist, so the start date and billing period are locked — rate and notes still change."}
            </p>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------- handling events */

const EVENT_LABEL: Record<string, string> = { in: "In", out: "Out", access: "Access" };

function HandlingEventsSection({ let_, rates }: { let_: LetRow; rates: StorageRates }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({
    event_date: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }),
    kind: "access" as "in" | "out" | "access",
    amount: String(rates.handlingEventInc),
    notes: "",
  });
  const [pending, start] = useTransition();

  // Same guarded-transition pattern as the parent dialog: a rejection must
  // surface as a toast, never strand the section's pending state.
  function run(fn: () => Promise<void>) {
    start(async () => {
      try {
        await fn();
      } catch {
        toast.error("Something went wrong — check whether the change landed before retrying.");
      }
    });
  }

  function add() {
    run(async () => {
      const res = await recordHandlingEventAction({
        let_id: let_.id,
        event_date: v.event_date,
        kind: v.kind,
        amount: Number(v.amount),
        notes: v.notes,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Handling event recorded — it bills on the next invoice.");
      setAdding(false);
      router.refresh();
    });
  }

  function remove(id: string) {
    run(async () => {
      const res = await deleteHandlingEventAction(id);
      if (!res.ok) {
        // Honest failure ("may have just been billed") — refresh so the row
        // shows its real billed state instead of a still-deletable one.
        toast.error(res.error);
        router.refresh();
        return;
      }
      toast.success("Handling event removed.");
      router.refresh();
    });
  }

  return (
    <section className="rounded-md border border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="eyebrow">Handling</p>
        {!adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" strokeWidth={1.75} />
            Add event
          </Button>
        ) : null}
      </div>
      {adding ? (
        <div className="mb-3 grid gap-3 rounded-md border border-input bg-muted/40 p-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="he-date" className="eyebrow mb-1.5 block">
                Date
              </label>
              <input
                id="he-date"
                type="date"
                value={v.event_date}
                onChange={(e) => setV({ ...v, event_date: e.target.value })}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="he-kind" className="eyebrow mb-1.5 block">
                Kind
              </label>
              <select
                id="he-kind"
                value={v.kind}
                onChange={(e) => setV({ ...v, kind: e.target.value as "in" | "out" | "access" })}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="in">In</option>
                <option value="out">Out</option>
                <option value="access">Access</option>
              </select>
            </div>
            <div>
              <label htmlFor="he-amount" className="eyebrow mb-1.5 block">
                Charge (£)
              </label>
              <input
                id="he-amount"
                type="number"
                min="0"
                step="0.01"
                value={v.amount}
                onChange={(e) => setV({ ...v, amount: e.target.value })}
                className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={pending} className="bg-mm-red text-white hover:bg-mm-red-deep">
              {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Record event
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {let_.handling_events.length ? (
        <ul className="divide-y border-t">
          {let_.handling_events.map((ev) => (
            <li key={ev.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="tabular min-w-0 flex-1 truncate text-foreground">
                {fmtDay(ev.event_date)} · {EVENT_LABEL[ev.kind] ?? ev.kind} · {gbp(ev.amount)}
              </span>
              <span
                className={cn(
                  "rounded-pill px-2 py-0.5 text-[11px] font-semibold",
                  ev.billed ? "bg-success-bg text-success" : "bg-muted text-mist-500",
                )}
              >
                {ev.billed ? "Billed" : "To bill"}
              </span>
              {!ev.billed ? (
                <button
                  type="button"
                  onClick={() => remove(ev.id)}
                  disabled={pending}
                  aria-label="Remove handling event"
                  className="focus-ring flex size-8 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-danger"
                >
                  <Trash2 className="size-4" strokeWidth={1.75} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-mist-400">
          No handling events yet. Each crate movement (in, out, or access) is a chargeable event — it bills on the next
          invoice.
        </p>
      )}
    </section>
  );
}
