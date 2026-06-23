"use client";

/**
 * Lead detail action bar — the common next steps one tap away, instead of a
 * tab-dig: Call, WhatsApp, Email, Mark contacted, New quote, Book survey.
 * Mark-contacted stamps first_contacted_at (feeds the dashboard response metric)
 * and only shows while the lead is active + uncontacted.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Phone, MessageCircle, Mail, Check, FileText, CalendarPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { markLeadContactedAction } from "@/app/(dashboard)/leads/actions";

const CLOSED = new Set(["completed", "declined"]);

function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d.length >= 10 ? d : null;
}

const btn =
  "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50";

export function LeadActionBar({
  leadId,
  phone,
  email,
  status,
  firstContactedAt,
}: {
  leadId: string;
  phone?: string | null;
  email?: string | null;
  status: string;
  firstContactedAt?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const wa = waNumber(phone);
  const uncontacted = !CLOSED.has(status) && !firstContactedAt;

  function markContacted() {
    start(async () => {
      const res = await markLeadContactedAction(leadId);
      if (!res.ok) toast.error(res.error || "Could not mark contacted.");
      else {
        toast.success("Marked contacted.");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2 border-t px-5 py-4">
      {phone ? (
        <a href={`tel:${phone}`} className={btn} aria-label="Call">
          <Phone className="size-4 text-[#2563eb]" strokeWidth={1.75} />
          Call
        </a>
      ) : null}
      {wa ? (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className={btn} aria-label="WhatsApp">
          <MessageCircle className="size-4 text-[#16a34a]" strokeWidth={1.75} />
          WhatsApp
        </a>
      ) : null}
      {email ? (
        <a href={`mailto:${email}`} className={btn} aria-label="Email">
          <Mail className="size-4" strokeWidth={1.75} />
          Email
        </a>
      ) : null}
      {uncontacted ? (
        <button
          type="button"
          onClick={markContacted}
          disabled={pending}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-mm-red bg-mm-red-tint px-3 text-sm font-medium text-mm-red-deep transition-colors hover:bg-mm-red hover:text-white disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Check className="size-4" strokeWidth={1.75} />}
          Mark contacted
        </button>
      ) : null}
      <Link href={`/quotes/new?leadId=${leadId}`} prefetch={false} className={btn}>
        <FileText className="size-4 text-mm-red" strokeWidth={1.75} />
        New quote
      </Link>
      <Link href={`/schedule/surveys?leadId=${leadId}`} className={btn}>
        <CalendarPlus className="size-4" strokeWidth={1.75} />
        Book survey
      </Link>
    </div>
  );
}
