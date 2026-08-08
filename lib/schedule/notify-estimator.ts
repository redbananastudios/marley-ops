/**
 * Tell the ESTIMATOR about their own survey visits (Peter, 2026-08-08 — "we
 * should also send the estimator an SMS or an email or a push notification when
 * we book them in for a survey").
 *
 * Until now the estimator was written onto the appointment and told nothing.
 * The CUSTOMER got an email naming them ("Luke will visit you Thursday at 2"),
 * the diary showed it, and the estimator themselves found out by opening the
 * panel. A survey booked at 6pm for 9am the next morning could sit unseen all
 * night, and a rescheduled one left them holding a time the customer no longer
 * had.
 *
 * Two channels, deliberately not three:
 *  - PUSH  — instant, free, already built (lib/push). Lock-screen safe: first
 *            name only, no address, no phone (categories.ts owns that rule).
 *  - EMAIL — the durable copy, and the one that carries the address, the
 *            customer's number and the booking notes. Goes through dispatchComm
 *            so it inherits the duplicate guard, the retry worker and the SMTP
 *            fallback.
 * SMS is deliberately omitted: it costs per message, the estimator is staff
 * with both a login and a mailbox, and push already covers "tell me now".
 *
 * Best-effort by contract: never throws, never blocks or unbooks the visit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errorContext } from "@/lib/log";
import { dispatchComm } from "@/lib/comms/dispatch";
import { accountsFrom } from "@/lib/comms/sender";
import { surveyAssignedPush } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import {
  estimatorSurveyEmailHtml,
  estimatorSurveyEmailText,
  estimatorSurveySubject,
} from "@/lib/comms/survey-email";
import { UK_TZ } from "@/lib/uk-time";

type Sb = SupabaseClient;

const appBase = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");

export interface EstimatorSurveyNotice {
  appointmentId: string;
  /** profiles.id of the estimator to tell. */
  estimatorUserId: string;
  kind: "booked" | "moved" | "removed" | "cancelled";
  /** Whoever performed the action — never notified about their own change. */
  actorUserId: string | null;
  startsAt: string;
  /** The slot being replaced, for a move or a hand-off. */
  previousStartsAt?: string | null;
  leadId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  address: string | null;
  notes: string | null;
}

/** "Thursday 10 July at 14:00" in UK wall-clock, or null for a bad timestamp. */
export function ukSlotLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const date = d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: UK_TZ,
  });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ });
  return `${date} at ${time}`;
}

function ukDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: UK_TZ });
}

/**
 * Fire the estimator's push + email. Returns what actually happened so the
 * caller can surface it in the UI toast rather than claiming a send it never
 * made — the same honesty rule the customer confirmation follows.
 */
export async function notifyEstimatorOfSurvey(
  notice: EstimatorSurveyNotice,
): Promise<{ push: boolean; email: boolean; skipped?: string }> {
  const none = { push: false, email: false };
  try {
    // Booking yourself in is not news. Mirrors resolvePushRecipients' actor rule
    // so the two channels can never disagree about who gets told.
    if (notice.actorUserId && notice.actorUserId === notice.estimatorUserId) {
      return { ...none, skipped: "self" };
    }
    // Tidying last month's diary must not ping anyone. A REMOVED notice for a
    // past visit is equally pointless — it already happened or it didn't.
    if (ukDay(new Date(notice.startsAt)) < ukDay(new Date())) {
      return { ...none, skipped: "past" };
    }

    const admin = createAdminClient() as unknown as Sb;

    // A cancelled appointment must never generate "you're surveying X" — the
    // dialog can be left open across a cancellation in another tab. The
    // cancellation notice itself is the one message that MUST still go out on a
    // cancelled row, so it is exempt.
    const { data: appt } = await admin
      .from("appointments")
      .select("id, status")
      .eq("id", notice.appointmentId)
      .maybeSingle();
    if (!appt) return { ...none, skipped: "missing" };
    if (appt.status === "cancelled" && notice.kind !== "cancelled") {
      return { ...none, skipped: "cancelled" };
    }

    const { data: estimator } = await admin
      .from("profiles")
      .select("id, full_name, email, active")
      .eq("id", notice.estimatorUserId)
      .maybeSingle();
    if (!estimator?.active) return { ...none, skipped: "inactive" };

    const dateLabel = new Date(notice.startsAt).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: UK_TZ,
    });
    const timeLabel = new Date(notice.startsAt).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: UK_TZ,
    });

    const pushSummary = await sendPushForEvent(
      surveyAssignedPush({
        kind: notice.kind,
        appointmentId: notice.appointmentId,
        customerName: notice.customerName,
        startsAt: notice.startsAt,
        leadId: notice.leadId,
      }),
      { recipientUserIds: [notice.estimatorUserId], actorUserId: notice.actorUserId },
    );

    let emailed = false;
    if (estimator.email) {
      const copy = {
        estimatorName: estimator.full_name,
        customerName: notice.customerName,
        dateLabel,
        timeLabel,
        address: notice.address,
        customerPhone: notice.customerPhone,
        notes: notice.notes,
        kind: notice.kind,
        previousLabel: ukSlotLabel(notice.previousStartsAt) ?? null,
        leadUrl: notice.leadId ? `${appBase()}/leads/${notice.leadId}` : null,
      } as const;
      // No leadId on the row: this is internal mail about a customer, not to
      // them — it must not land on the customer's Comms tab and read as
      // something they were sent. The dispatch key still dedupes it.
      const sent = await dispatchComm(admin, notice.actorUserId, {
        channel: "email",
        from: accountsFrom(),
        to: estimator.email,
        subject: estimatorSurveySubject(copy),
        bodyText: estimatorSurveyEmailText(copy),
        bodyHtml: estimatorSurveyEmailHtml(copy),
      }).catch(() => ({ ok: false as const, error: "send crashed" }));
      emailed = ("ok" in sent && sent.ok) || "duplicate" in sent;
      if (!emailed) {
        log.warn("survey.estimator_notice.email_failed", {
          appointmentId: notice.appointmentId,
          kind: notice.kind,
        });
      }
    }

    return { push: pushSummary.accepted > 0, email: emailed };
  } catch (err) {
    log.error("survey.estimator_notice.error", {
      appointmentId: notice.appointmentId,
      kind: notice.kind,
      ...errorContext(err),
    });
    return { ...none, skipped: "error" };
  }
}
