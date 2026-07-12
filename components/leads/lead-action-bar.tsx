"use client";

/**
 * Lead detail action bar — context-aware. Contact actions are always one tap away;
 * the rest follow the funnel stage so you only ever see the sensible next move:
 *   - enquiry / survey booked → Book survey (primary) + Quote without survey (quiet)
 *   - quoted / provisional    → Mark won / Mark lost (+ quiet New quote)
 *   - confirmed               → Book removal (primary) + Mark completed
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
  PhoneMissed,
  Check,
  FileText,
  CalendarPlus,
  CheckCircle2,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { ContactAction } from "@/components/ui/contact-action";
import {
  markLeadContactedAction,
  updateLeadStatusAction,
} from "@/app/(dashboard)/leads/actions";
import { noReplyForLeadAction } from "@/app/(dashboard)/follow-ups/actions";
import { MarkWonButton, type WonQuote } from "@/components/leads/mark-won-button";
import { MarkLostButton } from "@/components/leads/mark-lost-button";

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
  "focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-input bg-card px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50";
const primaryBtn =
  "focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-mm-red px-4 text-sm font-semibold text-white transition-colors hover:bg-mm-red-deep disabled:opacity-50";

export function LeadActionBar({
  leadId,
  phone,
  email,
  status,
  firstContactedAt,
  quotes = [],
}: {
  leadId: string;
  phone?: string | null;
  email?: string | null;
  status: string;
  firstContactedAt?: string | null;
  quotes?: WonQuote[];
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
  const nextStep = uncontacted
    ? { title: "Contact the customer", detail: "Make the first call, then mark the lead contacted." }
    : preQuote
      ? { title: "Book the survey", detail: "Choose the estimator and visit time. The quote follows the survey." }
      : quoting
        ? { title: "Close the quote", detail: "Record the outcome or create a revised quote." }
        : confirmed
          ? { title: "Book the removal", detail: "Put the confirmed move into the diary and assign resources." }
          : status === "completed"
            ? { title: "Workflow complete", detail: "The move is complete; all actions remain available in the record." }
            : { title: "Review this lead", detail: "Check the record and choose the next appropriate action." };

  return (
    <div className="border-t bg-muted/35">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div>
          <p className="eyebrow">Recommended next step</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{nextStep.title}</p>
          <p className="mt-0.5 text-xs text-mist-400">{nextStep.detail}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
      {/* contact — always available. When the lead is still uncontacted the call
          is the primary CTA (deliberate red); otherwise the neutral central
          contact style keeps every contact action uniform across the app. */}
      {phone ? (
        uncontacted ? (
          <a href={`tel:${phone}`} className={primaryBtn} aria-label="Call">
            <Phone className="size-4" strokeWidth={1.75} />
            Call customer
          </a>
        ) : (
          <ContactAction kind="call" href={`tel:${phone}`} variant="button" />
        )
      ) : null}
      {wa ? <ContactAction kind="whatsapp" href={`https://wa.me/${wa}`} variant="button" /> : null}
      {email ? <ContactAction kind="email" href={`mailto:${email}`} variant="button" /> : null}
      {uncontacted ? (
        <button
          type="button"
          onClick={markContacted}
          disabled={pending}
          className={btn}
        >
          <Check className="size-4 text-success" strokeWidth={1.75} />
          Mark contacted
        </button>
      ) : null}
      {!CLOSED.has(status) ? (
        <button
          type="button"
          onClick={() =>
            run(() => noReplyForLeadAction(leadId), "No-reply logged — follow-up queued for tomorrow.")
          }
          disabled={pending}
          title="Tried to reach them, no answer — retry tomorrow"
          className={btn}
        >
          <PhoneMissed className="size-4 text-mm-red" strokeWidth={1.75} />
          No reply
        </button>
      ) : null}

      {/* stage-driven next steps — pushed to the right */}
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}

        {preQuote && !uncontacted ? (
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
            <MarkWonButton leadId={leadId} quotes={quotes} className={primaryBtn} />
            <MarkLostButton leadId={leadId} />
            <Link href={`/quotes/new?leadId=${leadId}`} prefetch={false} className={btn}>
              <FileText className="size-4 text-mm-red" strokeWidth={1.75} />
              New quote
            </Link>
          </>
        ) : null}

        {confirmed ? (
          <>
            <Link href={`/schedule/removals?leadId=${leadId}`} className={primaryBtn}>
              <CalendarPlus className="size-4" strokeWidth={2} />
              Book removal
            </Link>
            <button type="button" onClick={() => setStatus("completed", "Marked completed.")} disabled={pending} className={btn}>
              <CheckCircle2 className="size-4 text-success" strokeWidth={2} />
              Mark completed
            </button>
          </>
        ) : null}

        {status === "declined" ? (
          <button type="button" onClick={() => setStatus("website_enquiry", "Reopened.")} disabled={pending} className={btn}>
            <RotateCcw className="size-4 text-mist-400" strokeWidth={1.75} />
            Reopen
          </button>
        ) : null}
      </span>
      </div>
    </div>
  );
}
