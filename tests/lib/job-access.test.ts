import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  profile: { id: "user-1", full_name: "Crew One", email: "crew@example.test", role: "crew", active: true } as
    | { id: string; full_name: string; email: string | null; role: "admin" | "estimator" | "crew"; active: boolean }
    | null,
  assigned: vi.fn(),
  admin: { marker: "admin" },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: mocks.user } })) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: mocks.profile })) })),
      })),
    })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/job-sheet-load", () => ({
  crewAssignedToAppointment: mocks.assigned,
}));

import { getActiveJobActor, requireAppointmentAccess } from "@/lib/job-access";

describe("job action access", () => {
  beforeEach(() => {
    mocks.user = { id: "user-1" };
    mocks.profile = {
      id: "user-1",
      full_name: "Crew One",
      email: "crew@example.test",
      role: "crew",
      active: true,
    };
    mocks.assigned.mockReset();
  });

  it("rejects missing and inactive profiles", async () => {
    mocks.user = null;
    await expect(getActiveJobActor()).resolves.toBeNull();

    mocks.user = { id: "user-1" };
    mocks.profile = { id: "user-1", full_name: "Crew", email: null, role: "crew", active: false };
    await expect(getActiveJobActor()).resolves.toBeNull();
  });

  it("allows active office actors without an assignment", async () => {
    mocks.profile = { id: "user-1", full_name: "Office", email: null, role: "admin", active: true };
    const access = await requireAppointmentAccess("appointment-1");
    expect(access?.actor.role).toBe("admin");
    expect(access?.admin).toBe(mocks.admin);
    expect(mocks.assigned).not.toHaveBeenCalled();
  });

  it("allows only crew assigned to the target appointment", async () => {
    mocks.assigned.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(requireAppointmentAccess("appointment-1")).resolves.not.toBeNull();
    await expect(requireAppointmentAccess("appointment-2")).resolves.toBeNull();
    expect(mocks.assigned).toHaveBeenNthCalledWith(
      1,
      mocks.admin,
      "user-1",
      "crew@example.test",
      "appointment-1",
    );
  });
});
