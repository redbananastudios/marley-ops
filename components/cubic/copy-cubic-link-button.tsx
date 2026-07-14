"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Link2, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import {
  emailCubicShareLinkAction,
  getCubicShareLinkAction,
  getCubicShareLinkByLeadAction,
} from "@/app/actions/cubic-survey";

/** Mints (lazily) + copies the customer self-fill link — /q "copy link" model.
 *  Works from a surveyId (builder) or a leadId (quote card, before a survey
 *  exists — the action creates it).
 *
 *  When `leadHasEmail` is passed (opt-in from the server component that knows
 *  the lead), an "Email survey link" button appears beside Copy — it sends the
 *  branded /cv link to the lead's email address. Needs `leadId` to send. */
export function CopyCubicLinkButton({
  surveyId,
  leadId,
  label = "Copy customer link",
  leadHasEmail,
  recipientName,
}: {
  surveyId?: string;
  leadId?: string;
  label?: string;
  /** Pass to also render "Email survey link" (needs leadId). false = shown
   *  disabled with a "no email on this lead" hint. */
  leadHasEmail?: boolean;
  recipientName?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const showEmail = leadHasEmail !== undefined && !!leadId;

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = surveyId
            ? await getCubicShareLinkAction(surveyId)
            : leadId
              ? await getCubicShareLinkByLeadAction(leadId)
              : ({ ok: false, error: "No survey reference." } as const);
          setBusy(false);
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          try {
            await navigator.clipboard.writeText(res.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
            toast.success("Customer link copied — they can fill the list themselves.");
          } catch {
            window.prompt("Copy the customer link:", res.url);
          }
        }}
        className="focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
        ) : copied ? (
          <Check className="size-4 text-success" strokeWidth={2} />
        ) : (
          <Link2 className="size-4" strokeWidth={1.75} />
        )}
        {copied ? "Copied" : label}
      </button>

      {showEmail ? (
        <button
          type="button"
          disabled={emailing || !leadHasEmail}
          title={leadHasEmail ? undefined : "No email on this lead"}
          onClick={async () => {
            setEmailing(true);
            const res = await emailCubicShareLinkAction(leadId!);
            setEmailing(false);
            if ("duplicate" in res) {
              toast.info("That survey link was already emailed to the customer.");
              return;
            }
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            toast.success(
              recipientName ? `Survey link emailed to ${recipientName}.` : "Survey link emailed to the customer.",
            );
            router.refresh();
          }}
          className="focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {emailing ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
          ) : (
            <Mail className="size-4" strokeWidth={1.75} />
          )}
          Email survey link
        </button>
      ) : null}
    </>
  );
}
