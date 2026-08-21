"use client";

/**
 * "Send again" for the deposit and commitment (25%) rails — the office's answer
 * to a customer who has lost the email that told them how to pay.
 *
 * Unlike the balance rail's button there is NO create action here: both
 * invoices are raised by the lifecycle (acceptance, date confirmation), so this
 * only ever re-sends what already exists. The dialog states the invoice number
 * and figure before anything sends, and shows the server's own refusal when the
 * send is not allowed — the verdict comes from the same guard the action
 * applies, so the button can never offer a send the server will reject.
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
  getInvoiceResendInfo,
  resendInvoiceAction,
  type InvoiceResendInfoResult,
} from "@/app/(dashboard)/invoicing/actions";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const COPY = {
  deposit: {
    button: "Deposit invoice",
    title: "Send the deposit request again",
    description:
      "Sends the same payment email again: the same amount, the same payment page and the same bank reference. The deposit invoice in Zoho is not created again or changed.",
    sent: "Deposit request sent again",
  },
  commitment: {
    button: "25% invoice",
    title: "Send the 25% invoice again",
    description:
      "Sends the same confirmation email again, with the same invoice number, the same figure and the invoice PDF attached. Nothing is created and nothing changes in Zoho.",
    sent: "Commitment invoice sent again",
  },
} as const;

export function ResendInvoiceButton({
  leadId,
  rail,
  size = "sm",
  variant = "outline",
  className,
}: {
  leadId: string;
  rail: "deposit" | "commitment";
  size?: "sm" | "default";
  variant?: "outline" | "default";
  className?: string;
}) {
  const router = useRouter();
  const copy = COPY[rail];
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<InvoiceResendInfoResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, startSend] = useTransition();

  async function openDialog() {
    setOpen(true);
    setLoading(true);
    setInfo(await getInvoiceResendInfo(leadId, rail));
    setLoading(false);
  }

  function send() {
    if (!info || !info.ok) return;
    startSend(async () => {
      const res = await resendInvoiceAction(info.quoteId, rail);
      if (!res.ok) {
        // Refused between opening the dialog and pressing the button — most
        // likely the money just landed. Show why, and correct the dialog.
        toast.error(res.error);
        setInfo(await getInvoiceResendInfo(leadId, rail));
        return;
      }
      toast.success(
        `${copy.sent}${res.invoiceNumber ? ` (${res.invoiceNumber})` : ""} — ${gbp(res.amount)} still due.`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  const sendable = !!info && info.ok && !info.blockedReason && !!info.customerEmail;

  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={openDialog}>
        <ReceiptText className="size-4" strokeWidth={1.75} />
        {copy.button}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
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
          ) : (
            <div className="space-y-3 py-2">
              <div className="rounded-md border border-border bg-muted p-4 text-sm">
                <p className="flex items-baseline justify-between">
                  <span className="text-mist-500">
                    {rail === "deposit" ? "Deposit" : "Commitment (25%)"}
                  </span>
                  <span className="tabular font-display text-2xl font-bold text-foreground">
                    {gbp(info.amount)}
                  </span>
                </p>
                <p className="mt-2 text-xs text-mist-400">
                  {info.customerName ? `${info.customerName} · ` : ""}
                  {info.quoteRef}
                  {info.invoiceNumber ? ` · invoice ${info.invoiceNumber}` : ""}
                </p>
                <p className="mt-2 border-t border-mist-200 pt-2 text-xs text-mist-400">
                  Email goes to{" "}
                  <span className="font-semibold text-foreground">
                    {info.customerEmail ?? "no email on file"}
                  </span>
                  .
                </p>
              </div>

              {info.blockedReason ? (
                <div
                  role="alert"
                  className="rounded-md border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn"
                >
                  {info.blockedReason}
                </div>
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
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
              {sendable ? "Cancel" : "Close"}
            </Button>
            {sendable && info.ok ? (
              <Button
                onClick={send}
                disabled={sending}
                className="bg-mm-red text-white hover:bg-mm-red-deep"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Send className="size-4" strokeWidth={1.75} />
                )}
                Send again to {info.customerEmail}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
