import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { requireUserOrCronSecret } from "@/lib/api-auth";

const originalCronSecret = process.env.CRON_SECRET;
const originalSyncCronSecret = process.env.SYNC_CRON_SECRET;

function request(authorization?: string): Request {
  return new Request("https://ops.example.test/api/cron/test", {
    headers: authorization ? { authorization } : undefined,
  });
}

function session(profile: { role: string; active: boolean } | null, userId = "user-1") {
  const single = vi.fn().mockResolvedValue({ data: profile });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    from,
  });
}

describe("requireUserOrCronSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRON_SECRET;
    delete process.env.SYNC_CRON_SECRET;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalSyncCronSecret === undefined) delete process.env.SYNC_CRON_SECRET;
    else process.env.SYNC_CRON_SECRET = originalSyncCronSecret;
  });

  it("accepts either configured scheduler secret without creating a session client", async () => {
    process.env.CRON_SECRET = "primary";
    process.env.SYNC_CRON_SECRET = "secondary";

    await expect(requireUserOrCronSecret(request("Bearer primary"))).resolves.toBe(true);
    await expect(requireUserOrCronSecret(request("Bearer secondary"))).resolves.toBe(true);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each(["admin", "estimator"])("accepts an active %s session", async (role) => {
    session({ role, active: true });
    await expect(requireUserOrCronSecret(request())).resolves.toBe(true);
  });

  it("rejects crew sessions", async () => {
    session({ role: "crew", active: true });
    await expect(requireUserOrCronSecret(request())).resolves.toBe(false);
  });

  it.each(["admin", "estimator"])("rejects an inactive %s session", async (role) => {
    session({ role, active: false });
    await expect(requireUserOrCronSecret(request())).resolves.toBe(false);
  });

  it("rejects unauthenticated sessions", async () => {
    session(null, "");
    await expect(requireUserOrCronSecret(request())).resolves.toBe(false);
  });
});
