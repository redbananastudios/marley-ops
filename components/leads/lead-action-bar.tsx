"use client";

/**
 * Lead detail action bar — context-aware. Contact actions are always one tap away;
 * the rest follow the funnel stage so you only ever see the sensible next move:
 *   - enquiry / survey booked → Book survey (primary) + Quote without survey (quiet)
 *   - quoted / provisional    → Mark won / Mark lost (+ quiet New quote)
 *   - confirmed               → Mark completed
 *   - completed / declined    → quiet Reopen (declined only)
 * Mark-contacted stamps first_contacted_at (the dashboard response metric) while the
 * lead is active + uncontacted. Booking a survey is the real next step on a fresh
 * lead — that's where the firm quote gets produced — so it's the primary CTA, with a
 * quiet escape hatch for phone-quoted small moves that skip the survey.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  Phone,
  MessageCircle,
  Mail,
  Check,
  FileText,
  CalendarPlus,
  Trophy,
  X,
  CheckCircle2,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import {
  markLeadContactedAction,
  updateLeadStatusAction,
} from "@/app/(dashboard)/leads/actions";

const CLOSED = new Set(["completed", "declined"]);
const FUNNEL = ["website_enquiry", "survey_booked", "quoted", "provisional", "confirmed", "completed"];
const idx = (s: string) => FUNNEL.indexOf(s);

function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d.length >= 10 ? d : null;
}

const btn =
  "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50";
const primaryBtn =
  "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3.5 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-50";

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

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error || "Something went wrong.");
      else {
        toast.success(ok);
        router.refresh();
      }
    });
  }

  const markContacted = () => run(() => markLeadContactedAction(leadId), "Marked contacted.");
  const setStatus = (s: string, msg: string) => run(() => updateLeadStatusAction(leadId, s), msg);

  const stage = idx(status);
  const preQuote = !CLOSED.has(status) && stage <= idx("survey_booked"); // enquiry / survey booked
  const quoting = status === "quoted" || status === "provisional";
  const confirmed = status === "confirmed";

  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-5 py-4">
      {/* contact — always available */}
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
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          <Check className="size-4 text-success" strokeWidth={1.75} />
          Mark contacted
        </button>
      ) : null}

      {/* stage-driven next steps — pushed to the right */}
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}

        {preQuote ? (
          <>
            <Link href={`/schedule/surveys?leadId=${leadId}`} className={primaryBtn}>
              <CalendarPlus className="size-4" strokeWidth={2} />
              Book survey
            </Link>
            <Link href={`/quotes/new?leadId=${leadId}`} prefetch={false} className={btn}>
              <FileText className="size-4 text-mist-400" strokeWidth={1.75} />
              Quote without survey
            </Link>
          </>
        ) : null}

        {quoting ? (
          <>
            <button type="button" onClick={() => setStatus("confirmed", "Marked won.")} disabled={pending} className={primaryBtn}>
              <Trophy className="size-4" strokeWidth={2} />
              Mark won
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm("Mark this lead as lost?")) setStatus("declined", "Marked lost.");
              }}
              disabled={pending}
              className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
            >
              <X className="size-4" strokeWidth={1.75} />
              Mark lost
            </button>
            <Link href={`/quotes/new?leadId=${leadId}`} prefetch={false} className={btn}>
              <FileText className="size-4 text-mm-red" strokeWidth={1.75} />
              New quote
            </Link>
          </>
        ) : null}

        {confirmed ? (
          <button type="button" onClick={() => setStatus("completed", "Marked completed.")} disabled={pending} className={primaryBtn}>
            <CheckCircle2 className="size-4" strokeWidth={2} />
            Mark completed
          </button>
        ) : null}

        {status === "declined" ? (
          <button type="button" onClick={() => setStatus("website_enquiry", "Reopened.")} disabled={pending} className={btn}>
            <RotateCcw className="size-4 text-mist-400" strokeWidth={1.75} />
            Reopen
          </button>
        ) : null}
      </span>
    </div>
  );
}
