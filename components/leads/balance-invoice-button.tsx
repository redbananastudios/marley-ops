"use client";

/**
 * "Final invoice" — the manual pre-move trigger. Opens a confirm dialog that
 * shows the EXACT amount + recipient before anything happens (one glance
 * catches a mistyped agreed price); confirming creates the Zoho invoice and
 * emails the customer. Once created it can never be created again — the
 * dialog then shows the invoice state instead of a confirm.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, ReceiptText, Send } from "lucide-react";
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
import {
  createBalanceInvoiceAction,
  getBalanceInvoiceInfo,
  resendBalanceInvoiceAction,
  type BalanceInvoiceInfoResult,
} from "@/app/(dashboard)/invoicing/actions";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function BalanceInvoiceButton({
  leadId,
  size = "sm",
  variant = "outline",
  className,
}: {
  leadId: string;
  size?: "sm" | "default";
  variant?: "outline" | "default";
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<BalanceInvoiceInfoResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, startSend] = useTransition();
  const [resending, startResend] = useTransition();

  async function openDialog() {
    setOpen(true);
    setLoading(true);
    setInfo(await getBalanceInvoiceInfo(leadId));
    setLoading(false);
  }

  function resend() {
    if (!info || !info.ok) return;
    startResend(async () => {
      const res = await resendBalanceInvoiceAction(info.quoteId);
      if (!res.ok) {
        toast.error(res.error);
        setInfo(await getBalanceInvoiceInfo(leadId)); // it may have just been paid
        return;
      }
      toast.success(`Invoice ${res.invoiceNumber} sent again — ${gbp(res.amount)} still due.`);
      setOpen(false);
      router.refresh();
    });
  }

  function confirm() {
    if (!info || !info.ok) return;
    startSend(async () => {
      const res = await createBalanceInvoiceAction(info.quoteId);
      if (!res.ok) {
        toast.error(res.error);
        setInfo(await getBalanceInvoiceInfo(leadId)); // reflect an already-created invoice
        return;
      }
      toast.success(
        `Invoice ${res.invoiceNumber} created${res.emailed ? " and emailed" : ""} — ${gbp(res.amount)} due.`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={openDialog}>
        <ReceiptText className="size-4" strokeWidth={1.75} />
        Final invoice
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Final invoice</DialogTitle>
            <DialogDescription>
              Payment in full is due before move day. This creates the balance invoice in Zoho and
              emails it to the customer — it can only ever happen once per job.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-mist-400" strokeWidth={1.75} />
            </div>
          ) : !info ? null : !info.ok ? (
            <div
              role="alert"
              className="rounded-md border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn"
            >
              {info.error}
            </div>
          ) : info.invoiceNumber ? (
            <div className="space-y-3 py-2">
              <div className="rounded-md border border-success-border bg-success-bg px-4 py-3 text-sm text-success">
                <p className="font-semibold">
                  Invoice {info.invoiceNumber} already exists — {gbp(info.invoiceAmount ?? info.amountDue)}{" "}
                  {info.balancePaid ? "· PAID" : "· awaiting payment"}
                </p>
                <p className="mt-1 text-xs">
                  {info.balancePaid
                    ? "Nothing further to send."
                    : "It will never be created twice. Send it again if the customer wants to pay now, or has lost the email — same invoice, same figure, with the PDF attached."}
                </p>
              </div>
              {!info.balancePaid ? (
                <Button
                  variant="outline"
                  onClick={resend}
                  disabled={resending || !info.customerEmail}
                  className="w-full"
                >
                  {resending ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <Send className="size-4" strokeWidth={1.75} />
                  )}
                  {info.customerEmail
                    ? `Send again to ${info.customerEmail}`
                    : "No email address on this job"}
                </Button>
              ) : null}
              {info.invoiceUrl ? (
                <a
                  href={info.invoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-2"
                >
                  <FileText className="size-4" strokeWidth={1.75} />
                  View hosted invoice
                </a>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="rounded-md border border-border bg-muted p-4 text-sm">
                <p className="flex items-baseline justify-between">
                  <span className="text-mist-500">Balance due</span>
                  <span className="tabular font-display text-2xl font-bold text-foreground">
                    {gbp(info.amountDue)}
                  </span>
                </p>
                <p className="mt-2 flex justify-between text-xs text-mist-400">
                  <span>
                    {info.quoteRef} · agreed {gbp(info.agreedPrice)} less {gbp(info.depositAmount)}{" "}
                    deposit{info.depositPaid ? "" : " (deposit still unpaid)"}
                  </span>
                </p>
                {info.moveDateLabel ? (
                  <p className="mt-1 text-xs text-mist-400">Move: {info.moveDateLabel}</p>
                ) : null}
                <p className="mt-2 border-t border-mist-200 pt-2 text-xs text-mist-400">
                  Email goes to{" "}
                  <span className="font-semibold text-foreground">
                    {info.customerEmail ?? "no email on file — invoice created only"}
                  </span>{" "}
                  with the Zoho invoice PDF attached.
                </p>
              </div>
              {!info.depositPaid ? (
                <p className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn">
                  Heads up: the deposit hasn&apos;t landed yet. The balance figure already excludes
                  it, so invoicing now is safe — but you may prefer to chase the deposit first.
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending || resending}>
              {info && info.ok && info.invoiceNumber ? "Close" : "Cancel"}
            </Button>
            {info && info.ok && !info.invoiceNumber ? (
              <Button
                onClick={confirm}
                disabled={sending || loading}
                className="bg-mm-red text-white hover:bg-mm-red-deep"
              >
                {sending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
                Create &amp; send {gbp(info.amountDue)} invoice
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
