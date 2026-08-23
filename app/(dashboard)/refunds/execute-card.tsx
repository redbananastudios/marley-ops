"use client";

/**
 * "To execute" row — per-rail payout controls for a determined (or
 * unconditional / Marley-cancel) refund entry.
 *
 *  card   in-ops takepayments refund per payment, armed by re-typing the exact
 *         amount (the server re-checks to the penny and reuses the atomic
 *         refundCardPayment reserve).
 *  bank   the operator pays out in the banking app first (keyed off the
 *         original payment reference — the feed carries no account numbers),
 *         then records it here, amount-retype-armed.
 *  cash   returns by bank transfer to a named account collected on the row.
 *
 * The terminal press (Complete / Retain) only unlocks once every due rail is
 * executed; every dialog locks while busy and never closes mid-flight.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { customerNoticeLabel, type CustomerNotice } from "@/lib/refunds/customer-notice";
import {
  completeRefundQueueAction,
  executeCardRefundAction,
  markRailRefundedAction,
  retainRefundQueueAction,
} from "@/app/actions/refunds";
import {
  gbpPence,
  RAIL_LABELS,
  type PaymentView,
  type QueueItemView,
  type RailView,
} from "@/lib/refunds/queue-view";

function dateLabel(day: string | null): string {
  if (!day) return "the original date";
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

const typedMatches = (typed: string, expectedPence: number): boolean => {
  const n = Number(typed.replace(/[£,\s]/g, ""));
  return Number.isFinite(n) && Math.round(n * 100) === expectedPence;
};

function DoneChip({ label = "Done" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-semibold text-success">
      <Check className="size-3" strokeWidth={2.5} /> {label}
    </span>
  );
}

/** Shared action-runner state: busy lockout + refresh-on-success. */
function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const processing = busy || refreshing;
  async function run(
    fn: () => Promise<{ ok: boolean; error?: string; already?: boolean; customerNotice?: CustomerNotice }>,
    /** A function when the wording depends on what the server actually did —
     *  the Complete and Retain dialogs used to assert "customer emailed." on
     *  every branch, including ones that emailed nobody (QA-20260823-03). */
    successMsg: string | ((res: { customerNotice?: CustomerNotice }) => string),
    onDone: () => void,
  ) {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error || "That didn't go through.");
        return;
      }
      const msg = typeof successMsg === "function" ? successMsg(res) : successMsg;
      // A notice that is anything other than a clean send is the office's
      // problem to act on, so it gets a warning toast and time to read it.
      const clean = !res.customerNotice || res.customerNotice === "sent" || res.customerNotice === "already_sent";
      if (res.already) toast.success("Already recorded — refreshing.");
      else if (clean) toast.success(msg);
      else toast.warning(msg, { duration: 12000 });
      onDone();
      startRefresh(() => router.refresh());
    } catch {
      toast.error("Couldn't reach the server — refresh and check the entry before retrying.");
    } finally {
      setBusy(false);
    }
  }
  return { processing, busy, run };
}

/* ------------------------------------------------------------- card rail */

function CardRefundDialog({ queueId, payment }: { queueId: string; payment: PaymentView }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const { processing, busy, run } = useRun();
  const outstanding = payment.refundDuePence - payment.executedPence;
  const armed = typedMatches(typed, outstanding);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
        if (next) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={processing}>
          Refund {gbpPence(outstanding)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Refund to the original card</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-mist-500">
            {gbpPence(outstanding)} goes back to the card this payment was made on, normally within 3 to 5 working
            days. This can&apos;t be undone.
          </p>
          <label className="block">
            <span className="eyebrow mb-1.5 block">Type the amount to confirm</span>
            <div className="flex h-10 w-40 items-center rounded-md border border-input bg-card px-2">
              <span className="mr-1 text-sm text-mist-400">£</span>
              <input
                type="text"
                inputMode="decimal"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={(outstanding / 100).toFixed(2)}
                className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                aria-label="Confirm refund amount"
              />
            </div>
            <span className="mt-1 block text-xs text-mist-400">
              Must match {gbpPence(outstanding)} exactly.
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={processing || !armed}
            onClick={() =>
              run(
                () => executeCardRefundAction(queueId, payment.cardPaymentId!, outstanding, typed),
                "Card refund sent.",
                () => setOpen(false),
              )
            }
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {processing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" strokeWidth={2} /> Refunding…
              </span>
            ) : (
              `Refund ${gbpPence(outstanding)}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------- bank/cash rails */

function MarkRailDialog({
  queueId,
  rail,
  quoteRef,
  initialRecipient,
}: {
  queueId: string;
  rail: RailView;
  quoteRef: string | null;
  initialRecipient: { name: string; sort: string; account: string } | null;
}) {
  const isCash = rail.rail === "cash";
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [name, setName] = useState(initialRecipient?.name ?? "");
  const [sort, setSort] = useState(initialRecipient?.sort ?? "");
  const [account, setAccount] = useState(initialRecipient?.account ?? "");
  const { processing, busy, run } = useRun();
  const due = rail.refundDuePence;
  const recipientOk = !isCash || (name.trim() && sort.trim() && account.trim());
  const armed = typedMatches(typed, due) && !!recipientOk;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
        if (next) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={processing}>
          Mark refunded
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isCash ? "Cash payment returned by bank transfer" : "Bank transfer refunded"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-mist-500">
            {isCash
              ? `Send ${gbpPence(due)} by bank transfer to the account below, then record it here.`
              : `Make the ${gbpPence(due)} transfer in the banking app first (find the inbound payment by its reference${quoteRef ? `, ${quoteRef}` : ""}), then record it here.`}{" "}
            Recording it counts the rail as paid out.
          </p>
          {isCash ? (
            <div className="space-y-2.5">
              <label className="block">
                <span className="eyebrow mb-1.5 block">Account name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-mm-red/40"
                  aria-label="Recipient account name"
                />
              </label>
              <div className="flex gap-2.5">
                <label className="block w-32">
                  <span className="eyebrow mb-1.5 block">Sort code</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    placeholder="00-00-00"
                    className="tabular h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-mm-red/40"
                    aria-label="Recipient sort code"
                  />
                </label>
                <label className="block flex-1">
                  <span className="eyebrow mb-1.5 block">Account number</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    className="tabular h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-mm-red/40"
                    aria-label="Recipient account number"
                  />
                </label>
              </div>
            </div>
          ) : null}
          <label className="block">
            <span className="eyebrow mb-1.5 block">Type the amount to confirm</span>
            <div className="flex h-10 w-40 items-center rounded-md border border-input bg-card px-2">
              <span className="mr-1 text-sm text-mist-400">£</span>
              <input
                type="text"
                inputMode="decimal"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={(due / 100).toFixed(2)}
                className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                aria-label="Confirm refunded amount"
              />
            </div>
            <span className="mt-1 block text-xs text-mist-400">Must match {gbpPence(due)} exactly.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={processing || !armed}
            onClick={() =>
              run(
                () =>
                  markRailRefundedAction(
                    queueId,
                    rail.rail as "bank_transfer" | "cash",
                    due,
                    typed,
                    isCash ? { name, sort, account } : undefined,
                  ),
                "Payout recorded.",
                () => setOpen(false),
              )
            }
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {processing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" strokeWidth={2} /> Recording…
              </span>
            ) : (
              `Mark ${gbpPence(due)} refunded`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- terminals */

function CompleteDialog({ item, isDateChange }: { item: QueueItemView; isDateChange: boolean }) {
  const [open, setOpen] = useState(false);
  const { processing, busy, run } = useRun();
  // The email itemises one line PER PAYMENT with a refund due (refundLinesFor
  // iterates rail.payments), not per rail — a single card rail can hold several
  // card payments, so counting rails would understate what the customer sees.
  const refundLineCount = item.rails
    .flatMap((r) => r.payments)
    .filter((p) => p.refundDuePence > 0).length;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={processing || !item.allExecuted}>
          {processing ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : isDateChange ? (
            "Close — money stays on the booking"
          ) : (
            "Complete the refund"
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isDateChange ? "Close this entry" : "Complete this refund"}</DialogTitle>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-mist-500">
          {isDateChange ? (
            <>
              The old day re-booked, so everything held ({gbpPence(item.heldPence)}) keeps counting toward the
              rebooked move. Nothing is paid out and no email is sent — the customer was already told everything
              paid moves with them.
            </>
          ) : (
            <>
              This closes the entry and sends the customer ONE itemised email confirming{" "}
              {gbpPence(item.refundDuePence)} has been returned across{" "}
              {refundLineCount}{" "}
              {refundLineCount === 1 ? "payment" : "payments"}.
            </>
          )}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={processing}
            onClick={() =>
              run(
                () => completeRefundQueueAction(item.id),
                isDateChange
                  ? "Entry closed — held money keeps counting toward the new booking."
                  : (res) => customerNoticeLabel(res.customerNotice, "Refund completed"),
                () => setOpen(false),
              )
            }
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {processing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" strokeWidth={2} /> {isDateChange ? "Closing…" : "Completing…"}
              </span>
            ) : isDateChange ? (
              "Close"
            ) : (
              "Complete"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetainDialog({ item, isDateChange }: { item: QueueItemView; isDateChange: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const { processing, busy, run } = useRun();
  const refundsDone = item.outstandingPence === 0;
  const armed = typedMatches(typed, item.retainPence);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
        if (next) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={processing || !refundsDone}>
          {processing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : "Retain — send the outcome email"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Retain the held amount</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-mist-500">
            {gbpPence(item.retainPence)} stays held against {dateLabel(item.originalMoveDate)} under the booking terms.
            {item.refundDuePence > 0
              ? ` The ${gbpPence(item.refundDuePence)} refunded above the held amount is itemised in the email.`
              : ""}{" "}
            The customer receives the outcome email when you confirm.
            {isDateChange
              ? ` It stops counting toward the rebooked move — the shortfall is recorded on this entry and the balance invoice for the new date will be ${gbpPence(item.retainPence)} higher.`
              : ""}
          </p>
          <label className="block">
            <span className="eyebrow mb-1.5 block">Type the retained amount to confirm</span>
            <div className="flex h-10 w-40 items-center rounded-md border border-input bg-card px-2">
              <span className="mr-1 text-sm text-mist-400">£</span>
              <input
                type="text"
                inputMode="decimal"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={(item.retainPence / 100).toFixed(2)}
                className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                aria-label="Confirm retained amount"
              />
            </div>
            <span className="mt-1 block text-xs text-mist-400">Must match {gbpPence(item.retainPence)} exactly.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={processing || !armed}
            onClick={() =>
              run(
                () => retainRefundQueueAction(item.id, typed),
                (res) => customerNoticeLabel(res.customerNotice, "Outcome recorded"),
                () => setOpen(false),
              )
            }
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {processing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" strokeWidth={2} /> Confirming…
              </span>
            ) : (
              "Retain and close"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ card */

export function ExecuteCard({ item }: { item: QueueItemView }) {
  const isRetainRow = item.determination === "not_filled";
  // A date-change row's booking is STILL LIVE: nothing ever pays out of it —
  // "filled" closes as released (money keeps counting), "not filled" retains
  // the conditional slice. The badge + terminals say so instead of "refund".
  const isDateChange = item.trigger === "customer_date_change";
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          {item.leadId ? (
            <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
              {item.customer}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{item.customer}</span>
          )}
          <p className="text-xs text-mist-400">
            {item.quoteRef ?? "—"} · {item.triggerLabel}
            {item.originalMoveDate ? ` · original date ${dateLabel(item.originalMoveDate)}` : ""}
          </p>
        </div>
        <span
          className={
            "rounded-full px-2.5 py-0.5 text-[11px] font-semibold " +
            (isRetainRow ? "bg-warn-bg text-warn" : "bg-success/10 text-success")
          }
        >
          {isDateChange
            ? isRetainRow
              ? `${gbpPence(item.retainPence)} retained · rest counts toward the booking`
              : "Counts toward the new booking"
            : isRetainRow
              ? `${gbpPence(item.retainPence)} held · refund ${gbpPence(item.refundDuePence)}`
              : `Full refund ${gbpPence(item.refundDuePence)}`}
        </span>
      </div>

      {item.notes ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-mist-500">{item.notes}</p>
      ) : null}

      {item.shortfallNote ? (
        <p className="rounded-md bg-warn-bg px-3 py-2 text-xs leading-relaxed text-warn">{item.shortfallNote}</p>
      ) : null}

      <ul className="space-y-2">
        {item.rails.map((rail) => (
          <li key={rail.rail} className="rounded-md border border-mist-150 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{RAIL_LABELS[rail.rail]}</p>
                <p className="text-xs text-mist-400">
                  {gbpPence(rail.heldPence)} held
                  {rail.retainPence > 0 ? ` · ${gbpPence(rail.retainPence)} retained` : ""}
                  {rail.refundDuePence > 0 ? ` · ${gbpPence(rail.refundDuePence)} to refund` : " · nothing to refund"}
                </p>
              </div>
              {rail.rail !== "card" ? (
                rail.refundDuePence <= 0 ? null : rail.executed ? (
                  <DoneChip label="Paid out" />
                ) : (
                  <MarkRailDialog
                    queueId={item.id}
                    rail={rail}
                    quoteRef={item.quoteRef}
                    initialRecipient={item.cashRecipient}
                  />
                )
              ) : null}
            </div>
            {rail.rail === "card" ? (
              <ul className="mt-2 space-y-1.5">
                {rail.payments.map((p) => (
                  <li key={p.key} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-mist-500">
                      <span className="capitalize">{p.label}</span> · {gbpPence(p.amountPence)} held
                    </span>
                    {p.refundDuePence <= 0 ? (
                      <span className="text-xs text-mist-400">retained in full</span>
                    ) : p.executed ? (
                      <DoneChip label="Refunded" />
                    ) : p.cardPaymentId ? (
                      <CardRefundDialog queueId={item.id} payment={p} />
                    ) : (
                      <span className="text-xs text-warn">No card reference on record — refund via the MMS.</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {rail.rail === "cash" && item.cashRecipient ? (
              <p className="mt-1.5 text-xs text-mist-400">
                Returns to {item.cashRecipient.name} · {item.cashRecipient.sort} · {item.cashRecipient.account}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2.5">
        {isRetainRow ? (
          <RetainDialog item={item} isDateChange={isDateChange} />
        ) : (
          <CompleteDialog item={item} isDateChange={isDateChange} />
        )}
        {item.outstandingPence > 0 ? (
          <span className="text-xs text-mist-400">
            Still to pay out: {gbpPence(item.outstandingPence)} — execute every line above first.
          </span>
        ) : null}
      </div>
    </div>
  );
}
