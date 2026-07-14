"use client";

/**
 * Compose a one-off branded email to a customer. Replaces the old mailto: links
 * across the panel: instead of bouncing to the operator's mail client, the
 * message is sent as a branded Marley Moves email (standard footer) and logged
 * to Comms via sendAdHocEmailAction — so there is a record of what went out.
 *
 * Two ways to use it:
 *  - <EmailComposeDialog> — controlled (open/onOpenChange + to). A list view can
 *    drive ONE dialog for many rows by swapping the recipient in state.
 *  - <EmailComposeButton> — a self-contained trigger + dialog for single-row use.
 *
 * Duplicate guard: if the identical email already went out, the dispatcher
 * returns { duplicate } and the dialog asks for a reason before re-sending with
 * override:true (mirrors the send-quote dialog).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail } from "lucide-react";
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
import { contactActionClass } from "@/components/ui/contact-action";
import { sendAdHocEmailAction } from "@/app/actions/send-email";

export interface EmailComposeDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Recipient — shown read-only. */
  to: string;
  leadId?: string;
  clientId?: string;
  defaultSubject?: string;
}

export function EmailComposeDialog({
  open,
  onOpenChange,
  to,
  leadId,
  clientId,
  defaultSubject,
}: EmailComposeDialogProps) {
  const router = useRouter();
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  // When the dispatcher reports the identical email already went out, hold the
  // detail here and show an in-dialog confirm + reason instead of window.confirm.
  const [dup, setDup] = useState<{ when: string; count: number } | null>(null);
  const [reason, setReason] = useState("");

  // Reseed each time the dialog opens (state only seeds once at mount; the
  // recipient/subject can change between opens when one dialog drives many rows).
  useEffect(() => {
    if (open) {
      setSubject(defaultSubject ?? "");
      setMessage("");
      setDup(null);
      setReason("");
    }
  }, [open, to, defaultSubject]);

  async function send(override?: { reason: string }) {
    if (!subject.trim()) {
      toast.error("Add a subject.");
      return;
    }
    if (!message.trim()) {
      toast.error("Write a message.");
      return;
    }
    setSending(true);
    try {
      const result = await sendAdHocEmailAction({
        to,
        subject: subject.trim(),
        message: message.trim(),
        leadId,
        clientId,
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
        toast.error(result.error || "Could not send the email.");
        setSending(false);
        return;
      }

      toast.success(`Email sent to ${to}.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the email.");
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Mail className="size-5 text-mm-red" strokeWidth={1.75} />
            Email customer
          </DialogTitle>
          <DialogDescription>
            To <span className="font-medium text-foreground">{to || "—"}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input
              id="compose-subject"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setDup(null);
              }}
              placeholder="What's this about?"
              maxLength={150}
              className="h-11"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="compose-message">Message</Label>
            <textarea
              id="compose-message"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setDup(null);
              }}
              rows={7}
              maxLength={5000}
              placeholder="Write your message. Leave a blank line between paragraphs."
              className="border-input placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px]"
            />
          </div>

          <p className="text-xs text-mist-400">
            Sent as a branded Marley Moves email with our standard footer, and logged to Comms.
          </p>

          {dup ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-mm-red/40 bg-mm-red-tint p-3 text-sm text-mm-red-deep"
            >
              <p>
                This exact email was already sent {dup.when}
                {dup.count > 1 ? ` (sent ${dup.count}×)` : ""} — send again?
              </p>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for re-sending"
                className="h-10 bg-card"
                aria-label="Reason for re-sending"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending} className="h-11">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => (dup ? send({ reason: reason.trim() }) : send())}
            disabled={sending || (dup !== null && reason.trim().length === 0)}
            className="h-11 bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <Mail className="size-4" strokeWidth={1.75} />
            )}
            {dup ? "Send anyway" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Self-contained trigger + dialog for single-recipient spots (lead action bar,
 *  appointment context, client page). Pass `className` to match the surrounding
 *  buttons; otherwise it falls back to the shared contact-action styling. */
export function EmailComposeButton({
  to,
  leadId,
  clientId,
  defaultSubject,
  label = "Email",
  className,
  variant = "button",
  iconClassName = "size-4 shrink-0",
  disabled,
}: {
  to: string;
  leadId?: string;
  clientId?: string;
  defaultSubject?: string;
  label?: string;
  className?: string;
  variant?: "icon" | "button";
  iconClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={variant === "icon" ? label : undefined}
        title={label}
        className={className ?? contactActionClass(variant)}
      >
        <Mail className={iconClassName} strokeWidth={1.75} />
        {variant === "button" ? label : null}
      </button>
      <EmailComposeDialog
        open={open}
        onOpenChange={setOpen}
        to={to}
        leadId={leadId}
        clientId={clientId}
        defaultSubject={defaultSubject}
      />
    </>
  );
}
