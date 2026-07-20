import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert, info, warn, error } = vi.hoisted(() => ({
  insert: vi.fn().mockResolvedValue({ error: null }),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert }) }),
}));

vi.mock("@/lib/log", () => ({
  log: { info, warn, error },
  errorContext: (value: unknown) => ({ error: value instanceof Error ? value.message : String(value) }),
}));

import { runCron } from "@/lib/cron/run-logger";

describe("runCron", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a normal summary as successful", async () => {
    const result = await runCron("test", async () => ({ processed: 2 }));
    expect(result).toMatchObject({ ok: true, status: 200, summary: { processed: 2 } });
    expect(info).toHaveBeenCalledWith("cron.done", expect.any(Object));
  });

  it("turns a structured integration failure into a failed run", async () => {
    const result = await runCron("test", async () => ({ ok: false, error: "provider unavailable" }));
    expect(result).toMatchObject({ ok: false, status: 500, error: "provider unavailable" });
    expect(error).toHaveBeenCalledWith("cron.failed", expect.objectContaining({ error: "provider unavailable" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error: "provider unavailable" }));
  });
});
