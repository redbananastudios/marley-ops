"use client";

/**
 * Client-side runners for the offline outbox — maps a queued item's kind to the
 * server action that applies it. A runner NEVER throws for a normal server
 * rejection: it returns 'done' (accepted, including the idempotent
 * already-applied case), 'failed' (permanent — surfaced to the crew), and lets
 * a network/transport error throw so the flush core treats it as a retry.
 */

import { completeJobAction, type CompletionInput } from "@/app/actions/crew-signatures";
import type { RunnerMap } from "@/lib/offline/outbox";

export interface JobCompletionPayload {
  appointmentId: string;
  input: CompletionInput;
}

export const outboxRunners: RunnerMap = {
  job_completion: async (payload) => {
    const p = payload as JobCompletionPayload;
    // Offline → the RPC fetch rejects → throws → flush retries. Online → a
    // returned {ok:false} is a server rejection of an already-validated payload
    // (e.g. the appointment vanished): permanent, surface it. {ok:true} covers
    // alreadyCompleted (the idempotent replay), so exactly-once holds.
    const res = await completeJobAction(p.appointmentId, p.input);
    return res.ok ? { outcome: "done" } : { outcome: "failed", error: res.error };
  },
};
