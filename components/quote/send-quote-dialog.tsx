"use client";

/**
 * Send-quote dialog. Confirms the recipient, builds the branded email HTML +
 * the quote PDF (base64), and fires sendCommunication(). Handles the comms
 * duplicate-guard: if the exact email already went out, ask before re-sending
 * with override:true.
 */

import { useEffect, useState } from "react";
import { Loader2, Mail, Paperclip } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendCommunication } from "@/app/(dashboard)/comms-actions";
import { setQuoteStatus } from "@/app/(dashboard)/quotes/actions";
import { buildQuoteEmailHtml } from "@/lib/comms/quote-email";
import { quotePdfBase64 } from "@/lib/quote/pdf-client";
import type { QuoteFormValues } from "@/lib/quote/form-types";
import type { QuoteBreakdown } from "@/lib/quote/pricing";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function SendQuoteDialog({
  open,
  onOpenChange,
  quoteId,
  quoteRef,
  values,
  breakdown,
  leadId,
  clientId,
  estimatorName,
  vatNumber,
  onSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  quoteId: string;
  quoteRef: string;
  values: QuoteFormValues;
  breakdown: QuoteBreakdown;
  leadId?: string | null;
  clientId?: string | null;
  estimatorName?: string | null;
  /** VAT registration number (Settings) — printed on the attached PDF's footer. */
  vatNumber?: string;
  onSent?: () => void;
}) {
  const [email, setEmail] = useState(values.customer.email || "");
  const [sending, setSending] = useState(false);
  // When the comms guard reports the identical email already went out, hold the
  // detail here and show an in-dialog confirm instead of a native window.confirm.
  const [dup, setDup] = useState<{ when: string; count: number } | null>(null);

  // Refresh the recipient from the latest customer email each time the dialog opens
  // (useState only seeds once at mount, before the wizard's customer step is filled).
  useEffect(() => {
    if (open) {
      setEmail(values.customer.email || "");
      setDup(null);
    }
  }, [open, values.customer.email]);

  async function doSend(override?: { reason: string }) {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error("Enter a valid customer email address.");
      return;
    }
    setSending(true);
    try {
      const bodyHtml = buildQuoteEmailHtml(values, breakdown, { quoteRef });
      const attachmentBase64 = await quotePdfBase64(values, breakdown, {
        quoteRef,
        estimatorName: estimatorName ?? undefined,
        vatNumber,
      });

      const result = await sendCommunication({
        channel: "email",
        to: email.trim(),
        subject: `Your removal quote from Marley Moves — ${quoteRef}`,
        bodyHtml,
        bodyText: "Your removal quote is attached.",
        attachmentBase64,
        attachmentName: `MarleyMoves-Quote-${quoteRef}.pdf`,
        quoteId,
        leadId: leadId ?? undefined,
        clientId: clientId ?? undefined,
        override: override ? true : undefined,
        overrideReason: override?.reason,
      });

      if ("duplicate" in result) {
        const when = result.lastSentAt
          ? new Date(result.lastSentAt).toLocaleString("en-GB")
          : "earlier";
        setDup({ when, count: result.sendCount });
        setSending(false);
        return;
      }

      if (!result.ok) {
        toast.error(result.error || "Could not send the quote.");
        setSending(false);
        return;
      }

      await setQuoteStatus(quoteId, "sent");
      toast.success(`Quote emailed to ${email.trim()}.`);
      onSent?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the quote.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Send quote {quoteRef}</DialogTitle>
          <DialogDescription>
            The branded email and the quote PDF go to the customer. Status moves to Sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="send-to" className="mb-2 block">
              Customer email
            </Label>
            <Input
              id="send-to"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setDup(null);
              }}
              placeholder="jane@example.com"
              className="h-12"
            />
          </div>

          {dup ? (
            <div
              role="alert"
              className="rounded-md border border-mm-red/40 bg-mm-red-tint p-3 text-sm text-mm-red-deep"
            >
              This exact quote email already went to this address {dup.when} (sent{" "}
              {dup.count}×). Send it again?
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-muted p-3 text-sm">
            <p className="flex items-center justify-between">
              <span className="text-mist-500">Total move cost</span>
              <span className="tabular font-display text-lg font-bold text-foreground">
                {gbp(breakdown.grandTotal)}
              </span>
            </p>
            <p className="mt-2 flex items-center gap-2 text-xs text-mist-400">
              <Paperclip className="size-3.5" strokeWidth={1.75} />
              MarleyMoves-Quote-{quoteRef}.pdf attached
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              dup ? doSend({ reason: "Operator re-sent identical quote email" }) : doSend()
            }
            disabled={sending}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <Mail className="size-4" strokeWidth={1.75} />
            )}
            {dup ? "Send again" : "Send quote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
