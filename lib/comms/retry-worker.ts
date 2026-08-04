/**
 * Durable comms-retry worker (Layer 2 of the delivery guarantee).
 *
 * Layer 1 (in-process retry in sendEmail) rescues the common transient blip at
 * send time. This worker is the backstop for everything it can't: the process
 * died mid-send, the provider was down for minutes, or the DB finalisation
 * failed after the provider accepted. It re-drives any still-failed outbound
 * communication through the EXISTING safe path — reclaim (which enforces the
 * duplicate-safe window: email only inside Resend's 24h idempotency window, SMS
 * only when the request provably never left) → runProviderSend (same stored
 * payload, same marley-comm/<id> idempotency key). So a re-drive can never
 * double-send.
 *
 * It backs off between attempts, caps the number of attempts, and escalates to a
 * critical operational issue instead of looping forever. A recovered send
 * auto-resolves its issue inside runProviderSend.
 */

import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";
import { runProviderSend, sendOpsAlert, type ProviderRequest } from "@/lib/comms/dispatch";
import { escapeHtml } from "@/lib/comms/escape-html";
import { log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

/** Give up (and escalate) once a send has been attempted this many times. */
export const COMMS_RETRY_MAX_ATTEMPTS = 8;

/**
 * Hours after `provider_started_at` past which a failed email can no longer be
 * safely re-driven: this is the SAME cutoff `reclaim_communication_send` (migration
 * 0070) enforces — beyond it, the Resend idempotency key has lapsed, so a resend
 * would be a NEW message rather than a de-duplicated retry. Kept in step with the
 * SQL so the backstop only ever touches rows the main sweep genuinely cannot.
 */
export const COMMS_RECLAIM_WINDOW_HOURS = 23;

/**
 * Backoff since the last attempt, growing with attempt_count and capped at 60m.
 * Layer-1 already absorbed the sub-second blips, so this paces the durable
 * re-drive of anything that got past it: ~5m after the first failure, widening
 * each round, exhausting the cap after a couple of hours (a provider outage of
 * that length is a human's problem, not an infinite loop's).
 */
export function commsRetryBackoffMs(attemptCount: number): number {
  return Math.min(5 * Math.max(attemptCount, 1), 60) * 60_000;
}

/** Is a failed row due for another attempt (its backoff has elapsed)? */
export function commsRetryDue(row: { attempt_count: number; updated_at: string }, nowMs: number): boolean {
  return nowMs - new Date(row.updated_at).getTime() >= commsRetryBackoffMs(row.attempt_count);
}

interface RetryRow {
  id: string;
  channel: "email" | "sms";
  to_address: string;
  subject: string | null;
  lead_id: string | null;
  client_id: string | null;
  claim_token: string;
  attempt_count: number;
  provider_payload_hash: string | null;
  provider_request: ProviderRequest | null;
  content_hash: string | null;
  updated_at: string;
}

export interface CommsRetrySummary extends Record<string, unknown> {
  ok: true;
  candidates: number;
  redriven: number;
  recovered: number;
  escalated: number;
  waiting: number;
}

export async function runCommsRetry(sb: Sb, now = new Date()): Promise<CommsRetrySummary> {
  const nowMs = now.getTime();
  const empty: CommsRetrySummary = {
    ok: true, candidates: 0, redriven: 0, recovered: 0, escalated: 0, waiting: 0,
  };

  // Only outbound sends ever carry a provider_request, so that filter alone
  // excludes inbound-logged rows. Rows at/above the attempt cap are already
  // escalated and dropped from the sweep.
  const { data, error } = await sb
    .from("communications")
    .select(
      "id, channel, to_address, subject, lead_id, client_id, claim_token, attempt_count, provider_payload_hash, provider_request, content_hash, updated_at",
    )
    .eq("status", "failed")
    .not("provider_request", "is", null)
    .not("claim_token", "is", null)
    .lt("attempt_count", COMMS_RETRY_MAX_ATTEMPTS)
    .order("updated_at", { ascending: true })
    .limit(50);
  if (error || !data) return empty;

  const rows = data as unknown as RetryRow[];
  let redriven = 0, recovered = 0, escalated = 0, waiting = 0;

  for (const row of rows) {
    if (!row.provider_request || !row.provider_payload_hash) continue;
    if (!commsRetryDue(row, nowMs)) { waiting++; continue; }

    const newToken = randomUUID();
    const { data: reclaimed } = await sb.rpc("reclaim_communication_send", {
      p_id: row.id,
      p_old_claim_token: row.claim_token,
      p_new_claim_token: newToken,
      p_provider_payload_hash: row.provider_payload_hash,
      p_lease_seconds: 300,
    });
    // reclaim returns false when it isn't safe/possible to retry: an email past
    // the 24h window, an SMS whose outcome is unknown, or a lost race. Leave it.
    if (!reclaimed) { waiting++; continue; }

    redriven++;
    const res = await runProviderSend(sb, sb, {
      communicationId: row.id,
      claimToken: newToken,
      channel: row.channel,
      providerRequest: row.provider_request,
      leadId: row.lead_id,
      clientId: row.client_id,
      actorId: null,
      to: row.to_address,
      subject: row.subject,
      claimIssueKey: row.content_hash ? `communication-claim:${row.content_hash}` : null,
      retried: true,
    });
    if (res.ok) { recovered++; continue; }

    // Still failing — did this attempt hit the ceiling? The sweep excludes rows
    // already at/above the cap, so this fires exactly once, on the crossing.
    const { data: after } = await sb
      .from("communications")
      .select("attempt_count")
      .eq("id", row.id)
      .maybeSingle();
    if ((after?.attempt_count ?? 0) >= COMMS_RETRY_MAX_ATTEMPTS) {
      escalated++;
      await reportOperationalIssue(sb, {
        key: `communication:${row.id}`,
        severity: "critical",
        source: "comms-retry",
        event: "comm.retry.exhausted",
        message: "A customer message could not be delivered after repeated retries — send it manually.",
        context: {
          communicationId: row.id,
          channel: row.channel,
          to: row.to_address,
          subject: row.subject,
          attempts: after?.attempt_count,
        },
      });
    }
  }

  return { ok: true, candidates: rows.length, redriven, recovered, escalated, waiting };
}

interface UnretryableRow {
  id: string;
  channel: "email" | "sms";
  to_address: string;
  subject: string | null;
  lead_id: string | null;
  provider_request: ProviderRequest | null;
  provider_outcome_unknown: boolean | null;
  provider_started_at: string | null;
  created_at: string | null;
  attempt_count: number;
}

export interface UnretryableSummary extends Record<string, unknown> {
  stranded: number;
}

/**
 * Backstop for the delivery guarantee: a failed outbound comm the main sweep can
 * NEVER re-drive would otherwise hold its `communication:<id>` "provider failed"
 * issue OPEN forever — a silent error only the daily digest surfaces, with no
 * path to clear. Two ways a row lands here:
 *
 *   - provider_request IS NULL — the failure predates the durable-payload write
 *     (a transitional artefact), so there is no stored payload to resend; or
 *   - provider_started_at is older than the reclaim window (COMMS_RECLAIM_WINDOW_HOURS),
 *     so a resend is no longer duplicate-safe and reclaim_communication_send refuses it.
 *
 * Because the provider outcome was UNKNOWN (a timeout after dispatch), the message
 * may already have been delivered. So we notify a human ONCE — check Resend, resend
 * by hand only if it truly did not go out — and only THEN resolve the noisy in-app
 * error and advance attempt_count to the cap, so the signal is never hidden without
 * a trail and this fires exactly once per row. Post-fix this is near-never; it exists
 * so no failed customer message can strand silently. Never sends a customer message.
 */
export async function escalateUnretryableComms(sb: Sb, now = new Date()): Promise<UnretryableSummary> {
  const nowMs = now.getTime();
  const windowMs = COMMS_RECLAIM_WINDOW_HOURS * 60 * 60_000;
  const windowIso = new Date(nowMs - windowMs).toISOString();

  const { data, error } = await sb
    .from("communications")
    .select(
      "id, channel, to_address, subject, lead_id, provider_request, provider_outcome_unknown, provider_started_at, created_at, attempt_count",
    )
    .eq("status", "failed")
    .lt("attempt_count", COMMS_RETRY_MAX_ATTEMPTS)
    .or(`provider_request.is.null,provider_started_at.lt.${windowIso}`)
    .order("updated_at", { ascending: true })
    .limit(50);
  if (error || !data) {
    // A missing column (e.g. staging without 0084) makes the sweep dormant, not
    // broken — but log it so a real query failure isn't invisible as "0 stranded".
    if (error) log.warn("comms.unretryable.query_failed", { error: error.message });
    return { stranded: 0 };
  }

  const capRow = (id: string) =>
    sb.from("communications").update({ attempt_count: COMMS_RETRY_MAX_ATTEMPTS }).eq("id", id).eq("status", "failed");

  let stranded = 0;
  for (const row of data as unknown as UnretryableRow[]) {
    // Defensive re-check — never rely on the SQL filter alone. A row is only
    // truly un-retryable if it has no stored payload OR its send window closed.
    const noPayload = row.provider_request == null;
    const pastWindow =
      !!row.provider_started_at && nowMs - new Date(row.provider_started_at).getTime() >= windowMs;
    if (!noPayload && !pastWindow) continue;

    // Only surface (and clear) a row that still holds an OPEN issue. A failed row
    // whose issue is already resolved was handled elsewhere — cap it silently so
    // the sweep stops re-evaluating it, and never fire a spurious "undelivered".
    const { data: openIssue } = await sb
      .from("operational_issues")
      .select("id")
      .eq("issue_key", `communication:${row.id}`)
      .eq("status", "open")
      .maybeSingle();
    if (!openIssue) {
      await capRow(row.id);
      continue;
    }

    // Provider + delivery wording must be accurate — this alert drives a human's
    // resend decision. Email → Resend, SMS → Webex; naming the wrong console
    // risks a duplicate send. Only an UNKNOWN outcome "may have been delivered";
    // a hard reject definitely was not (null column → treat cautiously as unknown).
    const providerName = row.channel === "sms" ? "Webex" : "Resend";
    const outcomeUnknown = row.provider_outcome_unknown !== false;
    const reason = noPayload ? "no stored payload to resend automatically" : "past the safe automatic-resend window";
    const subjectNote = row.subject ? ` ("${escapeHtml(row.subject)}")` : "";
    const aroundWhen = row.created_at ? ` around ${escapeHtml(row.created_at)}` : "";
    const deliveryLine = outcomeUnknown
      ? `Its outcome is unknown, so it MAY already have been delivered. Check ${providerName} for this recipient${aroundWhen} and resend it by hand only if it did not go out.`
      : `It was NOT delivered (the provider rejected it). Resend it by hand from ${providerName}${aroundWhen}.`;
    const notified = await sendOpsAlert(
      outcomeUnknown
        ? "Customer message may be undelivered — verify by hand"
        : "Customer message failed to send — resend by hand",
      [
        `An outbound ${row.channel} to <strong>${escapeHtml(row.to_address)}</strong>${subjectNote} could not be delivered automatically (${reason}).`,
        `${deliveryLine} This alert fires once.`,
        // One click to the customer context, so "verify by hand" doesn't start
        // with a search (Peter, 2026-08-04: the MMR019 alert arrived linkless).
        ...(row.lead_id
          ? [
              `Lead: <a href="${(process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "")}/leads/${row.lead_id}">open in Marley Ops</a>`,
            ]
          : []),
      ],
      "system",
      `comm-unretryable/${row.id}`,
    );
    // Clear the in-app signal only AFTER a human has been told, so an undelivered
    // message is never hidden without a durable notification.
    if (!notified) continue;

    await resolveOperationalIssue(sb, `communication:${row.id}`);
    await capRow(row.id);
    stranded++;
  }

  return { stranded };
}
