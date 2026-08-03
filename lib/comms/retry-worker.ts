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
import { reportOperationalIssue } from "@/lib/ops/issues";
import { runProviderSend, type ProviderRequest } from "@/lib/comms/dispatch";

type Sb = SupabaseClient<Database>;

/** Give up (and escalate) once a send has been attempted this many times. */
export const COMMS_RETRY_MAX_ATTEMPTS = 8;

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
