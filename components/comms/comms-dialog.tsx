"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";

import { sendCommunication } from "@/app/(dashboard)/comms-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Channel = "email" | "sms";

type DuplicateState = {
  lastSentAt: string | null;
  sendCount: number;
};

export function CommsDialog({
  leadId,
  clientId,
  defaultEmail,
  defaultPhone,
  trigger,
  initialSubject,
  initialEmailBody,
  initialSmsBody,
}: {
  leadId?: string;
  clientId?: string;
  defaultEmail?: string;
  defaultPhone?: string;
  trigger?: React.ReactNode;
  /** Optional template prefill — applied on open + channel switch; fully editable. */
  initialSubject?: string;
  initialEmailBody?: string;
  initialSmsBody?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [channel, setChannel] = React.useState<Channel>(
    defaultEmail ? "email" : defaultPhone ? "sms" : "email",
  );
  const [to, setTo] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [duplicate, setDuplicate] = React.useState<DuplicateState | null>(null);

  // Reset state each time the dialog opens; prefill recipient per channel.
  React.useEffect(() => {
    if (!open) return;
    const initialChannel: Channel = defaultEmail
      ? "email"
      : defaultPhone
        ? "sms"
        : "email";
    setChannel(initialChannel);
    setTo(initialChannel === "email" ? (defaultEmail ?? "") : (defaultPhone ?? ""));
    setSubject(initialSubject ?? "");
    setBody((initialChannel === "email" ? initialEmailBody : initialSmsBody) ?? "");
    setDuplicate(null);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultEmail, defaultPhone]);

  function switchChannel(next: Channel) {
    if (next === channel) return;
    setChannel(next);
    setTo(next === "email" ? (defaultEmail ?? "") : (defaultPhone ?? ""));
    // Re-seed the template for the new channel only if the user hasn't diverged.
    const prevSeed = (channel === "email" ? initialEmailBody : initialSmsBody) ?? "";
    if (!body.trim() || body === prevSeed) {
      setBody((next === "email" ? initialEmailBody : initialSmsBody) ?? "");
    }
    setDuplicate(null);
  }

  function formatSentAt(value: string | null): string {
    if (!value) return "recently";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function doSend(override: boolean) {
    if (!to.trim()) {
      toast.error("Add a recipient first.");
      return;
    }
    if (!body.trim()) {
      toast.error("Write a message first.");
      return;
    }
    setSending(true);
    try {
      const result = await sendCommunication({
        channel,
        to: to.trim(),
        bodyText: body,
        subject: channel === "email" ? subject.trim() || undefined : undefined,
        leadId,
        clientId,
        ...(override
          ? { override: true, overrideReason: "Operator confirmed resend" }
          : {}),
      });

      if ("duplicate" in result && result.duplicate) {
        setDuplicate({
          lastSentAt: result.lastSentAt,
          sendCount: result.sendCount,
        });
        return;
      }
      if ("ok" in result && result.ok) {
        toast.success(channel === "email" ? "Email sent." : "SMS sent.");
        setOpen(false);
        router.refresh();
        return;
      }
      const err = "error" in result ? result.error : "Send failed.";
      toast.error(err || "Send failed.");
    } catch {
      toast.error("Something went wrong sending the message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <MessageSquare strokeWidth={1.75} />
            Message
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a message</DialogTitle>
          <DialogDescription>
            Free-text {channel === "email" ? "email" : "SMS"} to the customer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Channel toggle */}
          <div className="inline-flex rounded-md border p-0.5">
            {(
              [
                { key: "email" as const, label: "Email", Icon: Mail },
                { key: "sms" as const, label: "SMS", Icon: MessageSquare },
              ] satisfies { key: Channel; label: string; Icon: typeof Mail }[]
            ).map(({ key, label, Icon }) => {
              const active = channel === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchChannel(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-card text-foreground shadow-xs"
                      : "text-mist-400 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.75} />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <Label htmlFor="comms-to">
              {channel === "email" ? "Recipient email" : "Recipient number"}
            </Label>
            <Input
              id="comms-to"
              type={channel === "email" ? "email" : "tel"}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setDuplicate(null);
              }}
              placeholder={
                channel === "email" ? "name@example.com" : "+44 7…"
              }
            />
          </div>

          {channel === "email" && (
            <div className="space-y-2">
              <Label htmlFor="comms-subject">Subject</Label>
              <Input
                id="comms-subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setDuplicate(null);
                }}
                placeholder="Your move with Marley Moves"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="comms-body">Message</Label>
            <textarea
              id="comms-body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDuplicate(null);
              }}
              rows={6}
              placeholder="Type your message…"
              className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            {channel === "sms" && (
              <p className="text-xs text-mist-400">
                Standard SMS, ~160 chars/segment.
              </p>
            )}
          </div>

          {duplicate && (
            <div className="space-y-2 rounded-md border border-warn-border bg-warn-bg px-3 py-2.5 text-sm text-warn">
              <p>
                This exact message was already sent{" "}
                {formatSentAt(duplicate.lastSentAt)} (×{duplicate.sendCount}).
                Send anyway?
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending}
                onClick={() => doSend(true)}
              >
                Send anyway
              </Button>
            </div>
          )}
        </div>

        <DialogFooter showCloseButton>
          <Button type="button" disabled={sending} onClick={() => doSend(false)}>
            <Send strokeWidth={1.75} />
            {sending ? "Sending…" : channel === "email" ? "Send email" : "Send SMS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
