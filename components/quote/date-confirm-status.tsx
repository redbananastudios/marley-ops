"use client";

/**
 * Date-confirmation status chip + office actions (Payments Policy v2 §5A).
 * NOT yet mounted anywhere — the integration pass places it on the lead page
 * (Payments/Overview area) and the /bookings booked rows.
 *
 * States:
 *  - Confirmed   → green chip with the confirmed date/when.
 *  - Not confirmed (move date + deposit paid) → chip + "Copy confirmation
 *    link" (the customer's /q page) + "Confirm in person" dialog: the
 *    DATE_CONFIRM ack read with the customer, their name, and either a drawn
 *    pad signature or the typed-name script signature.
 *  - No move date / deposit unpaid → explanatory muted chip (confirmation is
 *    gated server-side anyway; the UI just says why).
 *
 * Copy rule: the word "penalty" never appears here — the ack label carries
 * the held/refunded-if-rebooked framing.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck2, CalendarClock, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/signature-pad";
import { dateConfirmAcks, type DateConfirmAckKey } from "@/lib/signatures";
import { ScriptSignature, renderNameToPng } from "@/lib/signature-script";
import {
  confirmDateInPersonAction,
  getDateConfirmLinkAction,
} from "@/app/actions/date-confirm";

export interface DateConfirmStatusState {
  dateConfirmedAt: string | null;
  /** yyyy-mm-dd move date on the money quote (null = not set yet). */
  movingDate: string | null;
  /** Pre-formatted date label for display, e.g. "Monday 20 July". */
  moveDateLabel?: string | null;
  depositPaidAt: string | null;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
}

const chipBase =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold";

export function DateConfirmStatus({
  leadId,
  state,
  companyName,
}: {
  leadId: string;
  state: DateConfirmStatusState;
  /**
   * The company the acknowledgment names as the party that may retain up to
   * 25% of what the customer has paid — the LEAD's brand name, so the wording
   * the office reads out in person is the wording the customer would have read
   * on their own /q. Absent/blank falls back to the default company, which is
   * today's behaviour and byte-identical for a single-brand install.
   *
   * UNWIRED at both call sites — app/(dashboard)/bookings/page.tsx and
   * app/(dashboard)/leads/[id]/page.tsx must pass this, or a second brand's
   * customer confirming in person still signs under the default company's
   * name. Those files were outside this change's lane.
   */
  companyName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  /* ----------------------------------------------------------- confirmed */
  if (state.dateConfirmedAt) {
    return (
      <span className={`${chipBase} border-success/30 bg-success/10 text-success`}>
        <CalendarCheck2 className="size-3.5" strokeWidth={2} />
        Date confirmed
        {state.moveDateLabel ? ` · ${state.moveDateLabel}` : ""}
        {fmtWhen(state.dateConfirmedAt) ? ` (${fmtWhen(state.dateConfirmedAt)})` : ""}
      </span>
    );
  }

  /* ------------------------------------------------------- not confirmable */
  if (!state.movingDate) {
    return (
      <span className={`${chipBase} border-mist-200 bg-mist-50 text-mist-400`}>
        <CalendarClock className="size-3.5" strokeWidth={2} />
        Date not confirmed · no move date set
      </span>
    );
  }
  if (!state.depositPaidAt) {
    return (
      <span className={`${chipBase} border-mist-200 bg-mist-50 text-mist-400`}>
        <CalendarClock className="size-3.5" strokeWidth={2} />
        Date not confirmed · deposit first
      </span>
    );
  }

  /* -------------------------------------------------- awaiting confirmation */
  async function copyLink() {
    setCopying(true);
    try {
      const res = await getDateConfirmLinkAction(leadId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      await navigator.clipboard.writeText(res.url);
      toast.success("Confirmation link copied — it opens their quote page.");
    } catch {
      toast.error("Couldn't copy the link.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${chipBase} border-warn-border bg-warn-bg text-warn`}>
        <CalendarClock className="size-3.5" strokeWidth={2} />
        Date not confirmed
      </span>
      <Button size="sm" variant="outline" disabled={copying} onClick={copyLink}>
        {copying ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={2} />
        ) : (
          <Link2 className="size-4" strokeWidth={1.75} />
        )}
        Copy confirmation link
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarCheck2 className="size-4" strokeWidth={1.75} />
        Confirm in person
      </Button>
      <ConfirmInPersonDialog
        leadId={leadId}
        moveDateLabel={state.moveDateLabel ?? null}
        companyName={companyName}
        open={open}
        onOpenChange={setOpen}
        onDone={() => router.refresh()}
      />
    </div>
  );
}

function ConfirmInPersonDialog({
  leadId,
  moveDateLabel,
  companyName,
  open,
  onOpenChange,
  onDone,
}: {
  leadId: string;
  moveDateLabel: string | null;
  companyName?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [acks, setAcks] = useState<Record<DateConfirmAckKey, boolean>>({ date_confirm: false });
  const [drawnSig, setDrawnSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ackList = useMemo(() => dateConfirmAcks(companyName), [companyName]);
  const allTicked = ackList.every((a) => acks[a.key]);

  function submit() {
    setError(null);
    if (name.trim().length < 2) {
      setError("Type the customer's full name.");
      return;
    }
    if (!allTicked) {
      setError("Read the confirmation with the customer and tick the box.");
      return;
    }
    startTransition(async () => {
      const typedSig = drawnSig ? null : await renderNameToPng(name);
      const res = await confirmDateInPersonAction(leadId, {
        signerName: name.trim(),
        acks,
        signatureDataUri: drawnSig,
        typedSignatureImage: typedSig,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(
        res.already ? "The date was already confirmed." : "Move date confirmed — the customer has the confirmation email.",
      );
      onOpenChange(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? null : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Confirm the move date</DialogTitle>
          <DialogDescription>
            {moveDateLabel ? `Move date: ${moveDateLabel}. ` : ""}
            Read the confirmation below with the customer, then take their signature. Their
            deposit stops being refundable from this point, and the commitment invoice is
            raised and emailed automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2.5">
            {ackList.map((a) => (
              <label
                key={a.key}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-mist-200 bg-white px-4 py-3 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red/[0.03]"
              >
                <input
                  type="checkbox"
                  checked={acks[a.key]}
                  onChange={(e) => {
                    setAcks((s) => ({ ...s, [a.key]: e.target.checked }));
                    setError(null);
                  }}
                  className="mt-0.5 size-5 shrink-0 accent-mm-red"
                />
                <span className="text-sm leading-snug text-ink">{a.label}</span>
              </label>
            ))}
          </div>

          <div>
            <label
              htmlFor="date-confirm-in-person-name"
              className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400"
            >
              Customer&apos;s full name
            </label>
            <input
              id="date-confirm-in-person-name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="e.g. Jane Smith"
              className="h-12 w-full rounded-md border border-mist-200 bg-white px-4 text-base text-ink outline-none transition focus:border-mm-red focus:ring-2 focus:ring-mm-red/20"
            />
          </div>

          <div>
            <SignaturePad onChange={setDrawnSig} label="Customer signs here (or leave blank to use their typed name)" />
            {!drawnSig ? (
              <div className="mt-2">
                <ScriptSignature name={name} />
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger"
            >
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            Confirm date
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
