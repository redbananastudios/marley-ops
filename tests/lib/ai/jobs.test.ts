import { describe, expect, it, vi } from "vitest";

import {
  drainAiJobs,
  type AiJobProcessResult,
  type AiJobRecord,
  type AiJobRuntime,
} from "@/lib/ai/jobs";

interface TestJob extends AiJobRecord {
  outcome: "done" | "blocked" | "throw";
}

function runtimeFor(jobs: TestJob[]): AiJobRuntime<TestJob> {
  const queue = [...jobs];
  return {
    claimNext: vi.fn(async () => queue.shift() ?? null),
    process: vi.fn(async (job, context): Promise<AiJobProcessResult> => {
      await context.heartbeat();
      if (job.outcome === "throw") throw new Error("provider failed");
      if (job.outcome === "blocked") return { status: "blocked", reason: "cap" };
      return { status: "done" };
    }),
    heartbeat: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    block: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

describe("drainAiJobs", () => {
  it("processes jobs and delegates every state transition to the runtime", async () => {
    const runtime = runtimeFor([
      { id: "one", outcome: "done" },
      { id: "two", outcome: "blocked" },
      { id: "three", outcome: "throw" },
    ]);

    await expect(
      drainAiJobs(runtime, {
        workerId: "worker-a",
        deadlineAtMs: 1_000_000,
        minRemainingToClaimMs: 1,
        now: () => 0,
      }),
    ).resolves.toEqual({ claimed: 3, done: 1, blocked: 1, failed: 1 });

    expect(runtime.complete).toHaveBeenCalledWith("one", "worker-a");
    expect(runtime.block).toHaveBeenCalledWith("two", "worker-a", "cap");
    expect(runtime.fail).toHaveBeenCalledWith("three", "worker-a", expect.any(Error));
    expect(runtime.heartbeat).toHaveBeenCalledTimes(3);
  });

  it("does not claim a job when the trigger deadline is too close", async () => {
    const runtime = runtimeFor([{ id: "one", outcome: "done" }]);

    const result = await drainAiJobs(runtime, {
      workerId: "worker-a",
      deadlineAtMs: 119_999,
      now: () => 0,
    });

    expect(result).toEqual({ claimed: 0, done: 0, blocked: 0, failed: 0 });
    expect(runtime.claimNext).not.toHaveBeenCalled();
  });

  it("honours the caller's job limit for an always-on loop", async () => {
    const runtime = runtimeFor([
      { id: "one", outcome: "done" },
      { id: "two", outcome: "done" },
    ]);

    const result = await drainAiJobs(runtime, {
      workerId: "worker-a",
      deadlineAtMs: 1_000,
      minRemainingToClaimMs: 0,
      maxJobs: 1,
      now: () => 0,
    });

    expect(result.claimed).toBe(1);
    expect(runtime.claimNext).toHaveBeenCalledTimes(1);
  });
});
