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
import { saveQuoteDraft, setQuoteStatus } from "@/app/(dashboard)/quotes/actions";
import { buildQuoteEmailHtml, quoteEmailTemplateVars } from "@/lib/comms/quote-email";
import { quotePdfBase64, quotePdfFilename } from "@/lib/quote/pdf-client";
import { docBrandFrom } from "@/lib/pdf/doc-brand";
import { PdfLoader } from "@/components/quote/pdf-loader";
import type { QuoteFormValues } from "@/lib/quote/form-types";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import { DEFAULT_BRAND, type Brand } from "@/lib/brand";

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
  leadEmail,
  estimatorName,
  vatNumber,
  depositAmount,
  acceptUrl,
  brand,
  paymentPolicy,
  resend,
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
  /** The lead's currently-stored email — the baseline the "Send to" address is
   *  compared against to decide whether to offer saving a correction back. Falls
   *  back to the quote's customer email when not supplied. */
  leadEmail?: string | null;
  estimatorName?: string | null;
  /** VAT registration number (Settings) — printed on the attached PDF's footer. */
  vatNumber?: string;
  /** Deposit £ (Settings) — used in the attached PDF's acceptance wording. */
  depositAmount?: number;
  /** Customer accept page (/q/<token>) — email CTA + the PDF's QR codes. */
  acceptUrl?: string;
  /** The quote's brand row (multi-brand PRD §3.5 + §3.6) — the FULL row, because
   *  the email needs it: subject line, chrome and reply-to all resolve from it.
   *  The slim, serialisable DocBrand the attached PDF's doc-def takes is derived
   *  from it below (docBrandFrom), so one prop still carries both gates. Absent,
   *  or marley, composes today's exact email and today's exact Marley PDF. */
  brand?: Brand | null;
  /** Which ladder this quote runs (PRD §3.10), resolved on the server. Drives
   *  BOTH the email body and the attached PDF from one value, so the two can
   *  never disagree about whether this customer owes a deposit. Absent means
   *  residential — today's exact email and today's exact document. */
  paymentPolicy?: "residential" | "commercial";
  /** Re-send of an already-sent/accepted quote (customer asked again). Preserves
   *  the quote's status — a re-send must never bump an accepted quote back to
   *  "sent" — and the duplicate override is reasoned "customer requested re-send". */
  resend?: boolean;
  onSent?: () => void;
}) {
  // The lead's stored email is the baseline; fall back to the quote's customer
  // email (first-send, before a lead correction exists).
  const baseline = (leadEmail ?? values.customer.email ?? "").trim();
  const norm = (s: string) => s.trim().toLowerCase();

  const [email, setEmail] = useState(baseline || values.customer.email || "");
  const [saveToLead, setSaveToLead] = useState(true);
  const [sending, setSending] = useState(false);
  // When the comms guard reports the identical email already went out, hold the
  // detail here and show an in-dialog confirm instead of a native window.confirm.
  const [dup, setDup] = useState<{ when: string; count: number } | null>(null);

  // Refresh the recipient from the latest customer/lead email each time the dialog
  // opens (useState only seeds once at mount, before the wizard's customer step is
  // filled), and default the save-back checkbox to ticked — a bounced address is
  // usually simply wrong, and chases/invoices keep using the lead's email.
  useEffect(() => {
    if (open) {
      setEmail((leadEmail ?? values.customer.email ?? "").trim());
      setSaveToLead(true);
      setDup(null);
    }
  }, [open, leadEmail, values.customer.email]);

  // Once the entered address differs from the lead's stored one, offer to adopt it.
  const differs = email.trim() !== "" && norm(email) !== norm(baseline);

  // Two gates, one `brand` prop. The EMAIL takes the full brands row (subject,
  // chrome, reply-to — PRD §3.5); the PDF doc-def takes the slim, serialisable
  // DocBrand (PRD §3.6), because it is built in the browser. docBrandFrom is the
  // bridge and returns null for the default brand, so a Marley quote renders
  // today's exact document from the doc-def's own literals — parity by
  // construction, not by the seeded row happening to hold the right values.
  const pdfBrand = brand ? docBrandFrom(brand) : null;

  async function doSend(override?: { reason: string }) {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error("Enter a valid customer email address.");
      return;
    }
    setSending(true);
    try {
      // Persist BEFORE emailing. The wizard's total is a live client-side
      // recompute, while quotes.subtotal/grand_total are only written by the
      // debounced autosave — which deliberately skips first render. Opening a
      // draft and sending it without touching a field therefore emailed one
      // price while the database (and accept-flow, which charges the deposit
      // from grand_total) held another (QA-20260823-02).
      //
      // A re-send is excluded on purpose: that quote's price is already what
      // the customer was sent, and recomputing it against today's pricing
      // settings would move it underneath them.
      if (!resend) {
        const saved = await saveQuoteDraft(quoteId, values);
        if (!saved.ok) {
          toast.error("Could not save this quote before sending: " + saved.error);
          setSending(false);
          return;
        }
        const shownPence = Math.round(breakdown.grandTotal * 100);
        const savedPence = Math.round(saved.breakdown.grandTotal * 100);
        if (shownPence !== savedPence) {
          // Pricing settings moved since this page loaded. Emailing now would
          // send a number the office never saw, so refuse rather than guess
          // which of the two is the one they meant.
          toast.error(
            `This quote now prices at ${gbp(saved.breakdown.grandTotal)}, not the ${gbp(breakdown.grandTotal)} on screen — pricing settings changed since this page loaded. Reload and review before sending.`,
            { duration: 15000 },
          );
          setSending(false);
          return;
        }
      }

      const emailMeta = {
        quoteRef,
        acceptUrl,
        depositAmount,
        brand,
        paymentPolicy,
        // The two-switch card verdict for a NON-default brand's deposit-step
        // copy (PRD §11.10). The page resolves `brand` through brandForComms,
        // so cardPaymentsEnabled here is the EFFECTIVE flag — global AND brand
        // — not the stored toggle. Marley never passes one: its literals stand
        // and depositStepCopy ignores the slot for the default brand.
        offerCard:
          brand && brand.slug !== DEFAULT_BRAND ? brand.cardPaymentsEnabled : undefined,
      };
      const bodyHtml = buildQuoteEmailHtml(values, breakdown, emailMeta);
      // Server prefers the published Resend template (dashboard-editable copy)
      // when its env id is set; bodyHtml stays as the fallback body.
      const templateVariables = quoteEmailTemplateVars(values, breakdown, emailMeta);
      const attachmentBase64 = await quotePdfBase64(values, breakdown, {
        quoteRef,
        estimatorName: estimatorName ?? undefined,
        vatNumber,
        depositAmount,
        acceptUrl,
        brand: pdfBrand,
        paymentPolicy,
      });

      const result = await sendCommunication({
        channel: "email",
        to: email.trim(),
        subject: `Your removal quote from ${brand && brand.slug !== "marley" ? brand.name : "Marley Moves"} — ${quoteRef}`,
        bodyHtml,
        ...(templateVariables ? { templateKey: "quote-email" as const, templateVariables } : {}),
        bodyText: "Your removal quote is attached.",
        attachmentBase64,
        // Gate 14's shared helper wins here: the emailed attachment must carry
        // exactly the name the PDF downloads under (brand shortName, PRD §10 —
        // Pitmans-Quote-PMR001.pdf), and for Marley pdfBrand is null, so this is
        // byte-identically today's MarleyMoves-Quote-<ref>.pdf.
        attachmentName: quotePdfFilename(quoteRef, pdfBrand),
        quoteId,
        leadId: leadId ?? undefined,
        clientId: clientId ?? undefined,
        // Server validates + normalises this and has the final say on the recipient.
        toEmail: email.trim(),
        // Only meaningful when the address differs from the lead's stored one; the
        // server double-guards on that difference before touching the lead.
        updateLeadEmail: differs && saveToLead,
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

      // A re-send never changes status (an accepted quote must stay accepted);
      // a first send moves the quote to "sent" AND retires the quote it replaces.
      const status = resend ? null : await setQuoteStatus(quoteId, "sent");
      // Sending a revision normally retires the earlier quote silently — that's
      // the point. It only speaks up when it couldn't, because a live duplicate
      // the office doesn't know about is how a customer ends up holding two prices.
      const warning = status && "warning" in status ? status.warning : null;
      if (warning) {
        toast.warning(warning, { duration: 12000 });
      } else {
        // A re-send is a quiet confirmation; a first send is the moment the chase
        // engine takes over, so say so — the estimator's steered away from the
        // wizard by onSent, and this is the reassurance that follow-up is handled.
        toast.success(
          resend
            ? `Quote re-sent to ${email.trim()}.`
            : "Quote sent — chase emails run automatically until they reply.",
        );
      }
      onSent?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the quote.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* The send builds the quote PDF in the browser (quotePdfBase64 →
          window.pdfMake), so the dialog carries its own loader — every surface
          that can send (builder, quote-detail re-send) gets the scripts by
          construction instead of each page having to remember. next/script
          dedupes by id, so the builder's own <PdfLoader/> mount is harmless.
          Mounted while closed too: the scripts load at page-load, not at the
          moment the office clicks send. (2026-08-07: Re-send on /quotes/[id]
          threw "PDF library not loaded" — that page never mounted the loader.) */}
      <PdfLoader />
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {resend ? "Re-send quote" : "Send quote"} {quoteRef}
          </DialogTitle>
          <DialogDescription>
            {resend
              ? "The branded email and the quote PDF go to the customer again. The quote's status is unchanged."
              : "The branded email and the quote PDF go to the customer. Status moves to Sent."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="send-to" className="mb-2 block">
              Send to
            </Label>
            <Input
              id="send-to"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setDup(null);
              }}
              placeholder="jane@example.com"
              className="h-12 text-base"
            />
            {differs ? (
              <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={saveToLead}
                  onChange={(e) => setSaveToLead(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-mm-red"
                />
                <span className="leading-snug">
                  Save as the lead&apos;s email address
                  <span className="mt-0.5 block text-xs text-mist-400">
                    Chases, deposit and balance invoices, and the review request will use this
                    address. Untick to send this one email only.
                  </span>
                </span>
              </label>
            ) : null}
          </div>

          {dup ? (
            <div
              role="alert"
              className="rounded-md border border-warn-border bg-warn-bg p-3 text-sm text-warn"
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
              {quotePdfFilename(quoteRef, pdfBrand)} attached
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              dup
                ? doSend({
                    reason: resend ? "customer requested re-send" : "Operator re-sent identical quote email",
                  })
                : doSend()
            }
            disabled={sending}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <Mail className="size-4" strokeWidth={1.75} />
            )}
            {dup ? "Send again" : resend ? "Re-send quote" : "Send quote"}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  );
}
