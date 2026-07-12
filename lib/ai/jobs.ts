export interface AiJobRecord {
  id: string;
}

export type AiJobProcessResult =
  | { status: "done" }
  | { status: "blocked"; reason: string };

export interface AiJobProcessorContext {
  workerId: string;
  deadlineAtMs: number;
  heartbeat: () => Promise<void>;
}

export interface AiJobRuntime<Job extends AiJobRecord> {
  claimNext(workerId: string): Promise<Job | null>;
  process(job: Job, context: AiJobProcessorContext): Promise<AiJobProcessResult>;
  heartbeat(jobId: string, workerId: string): Promise<void>;
  complete(jobId: string, workerId: string): Promise<void>;
  block(jobId: string, workerId: string, reason: string): Promise<void>;
  fail(jobId: string, workerId: string, error: unknown): Promise<void>;
}

export interface DrainAiJobsOptions {
  workerId: string;
  deadlineAtMs: number;
  minRemainingToClaimMs?: number;
  maxJobs?: number;
  now?: () => number;
}

export interface DrainAiJobsResult {
  claimed: number;
  done: number;
  failed: number;
  blocked: number;
}

const DEFAULT_MIN_REMAINING_TO_CLAIM_MS = 120_000;
const DEFAULT_MAX_JOBS = 25;

/**
 * Trigger-agnostic job drainer. Hosting adapters authenticate, construct the
 * runtime, set a deadline and call this function. The same function is usable
 * from a scheduled HTTP route or a long-running Node worker loop.
 */
export async function drainAiJobs<Job extends AiJobRecord>(
  runtime: AiJobRuntime<Job>,
  options: DrainAiJobsOptions,
): Promise<DrainAiJobsResult> {
  const now = options.now ?? Date.now;
  const minRemaining =
    options.minRemainingToClaimMs ?? DEFAULT_MIN_REMAINING_TO_CLAIM_MS;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;

  if (!options.workerId.trim()) throw new Error("AI worker ID is required");
  if (!Number.isFinite(options.deadlineAtMs)) throw new Error("AI worker deadline is required");
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("maxJobs must be positive");
  if (!Number.isFinite(minRemaining) || minRemaining < 0) {
    throw new Error("minRemainingToClaimMs must not be negative");
  }

  const result: DrainAiJobsResult = { claimed: 0, done: 0, failed: 0, blocked: 0 };

  while (
    result.claimed < maxJobs &&
    options.deadlineAtMs - now() >= minRemaining
  ) {
    const job = await runtime.claimNext(options.workerId);
    if (!job) break;
    result.claimed += 1;

    try {
      const processResult = await runtime.process(job, {
        workerId: options.workerId,
        deadlineAtMs: options.deadlineAtMs,
        heartbeat: () => runtime.heartbeat(job.id, options.workerId),
      });

      if (processResult.status === "blocked") {
        await runtime.block(job.id, options.workerId, processResult.reason);
        result.blocked += 1;
      } else {
        await runtime.complete(job.id, options.workerId);
        result.done += 1;
      }
    } catch (error) {
      await runtime.fail(job.id, options.workerId, error);
      result.failed += 1;
    }
  }

  return result;
}
