import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * /schedule?tab=alloc — Day Allocation (the Job Board component, still very
 * much alive: PR #60 deleted the standalone /schedule/board PAGE and its old
 * spec, but kept JobBoardView, which is now embedded here as the "Day
 * Allocation" tab of Schedule & Allocation, surveys hidden). No permanent spec
 * covered this surface at all before this file (qa/state.json
 * spec_gaps.office_job_board_view_spec) — resources rail, week navigation, and
 * the assign-staff/vehicle modal writing appointment_assignments were only
 * ever driven ad hoc.
 *
 * Live-verified against staging 2026-08-29 (QA audit): resources rail render,
 * Next/Previous week nav, and the modal-assign path all matched exactly, incl.
 * the SQL read-back on appointment_assignments after assigning both a staff
 * member and a vehicle in one Confirm.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down the marker fixture — set in CI, usually unset
 * locally. Deliberately does NOT seed its own staff/vehicle rows: it looks up
 * one already-active pair on the target DB (whatever CI/staging already
 * seeds), so this spec never grows the fleet/roster tables it doesn't own.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker appointment",
);

const MARKER = `QA-JOB-BOARD-VIEW-${Date.now()}`;

interface Fixture {
  clientId: string;
  leadId: string;
  appointmentId: string;
  staff: { id: string; full_name: string };
  vehicle: { id: string; name: string };
}

/** Today's UK calendar date, so the seeded appointment always lands inside the
 *  board's default "this week" window with no date navigation required. */
function ukToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();

  const { data: staff, error: sErr } = await sb
    .from("staff")
    .select("id, full_name")
    .eq("is_active", true)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (sErr || !staff) throw new Error(`no active staff on this DB to assign: ${sErr?.message ?? "none found"}`);

  const { data: vehicle, error: vErr } = await sb
    .from("vehicles")
    .select("id, name")
    .eq("is_active", true)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (vErr || !vehicle) throw new Error(`no active vehicle on this DB to assign: ${vErr?.message ?? "none found"}`);

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "website_enquiry",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900333",
      email: "qa-sentinel-sink@marleymoves.test",
      from_postcode: "SP7 8AA",
      to_postcode: "BH21 4DJ",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr || !lead) throw new Error(`seed lead: ${lErr?.message ?? "no row returned"}`);

  const day = ukToday();
  const { data: appt, error: aErr } = await sb
    .from("appointments")
    .insert({
      appt_type: "removal",
      client_id: client.id,
      lead_id: lead.id,
      title: `${MARKER} Client`,
      starts_at: `${day}T09:30:00Z`,
      ends_at: `${day}T12:30:00Z`,
      status: "scheduled",
      location: "seed",
    })
    .select("id")
    .single();
  if (aErr || !appt) throw new Error(`seed appointment: ${aErr?.message ?? "no row returned"}`);

  return {
    clientId: client.id as string,
    leadId: lead.id as string,
    appointmentId: appt.id as string,
    staff: staff as { id: string; full_name: string },
    vehicle: vehicle as { id: string; name: string },
  };
}

async function teardown(fx: Fixture) {
  const sb = adminClient();
  const problems: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) problems.push(`${label}: ${error.message}`);
  };
  check(
    "appointment_assignments",
    (await sb.from("appointment_assignments").delete().eq("appointment_id", fx.appointmentId)).error,
  );
  check("appointments", (await sb.from("appointments").delete().eq("id", fx.appointmentId)).error);
  check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
  check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);

  const { count } = await sb.from("leads").select("*", { count: "exact", head: true }).eq("notes", MARKER);
  if (count) problems.push(`leads: ${count} marker row(s) still present after delete`);
  const { count: apptCount } = await sb
    .from("appointment_assignments")
    .select("*", { count: "exact", head: true })
    .eq("appointment_id", fx.appointmentId);
  if (apptCount) problems.push(`appointment_assignments: ${apptCount} marker row(s) still present after delete`);
  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

/** Both the desktop-kanban grid and the tablet/phone stacked list render the
 *  SAME card text at once — one hidden by CSS depending on viewport. Return
 *  the actually-visible copy rather than the first DOM match. */
async function visibleCardLink(page: import("@playwright/test").Page, name: string) {
  const links = page.getByRole("link", { name, exact: true });
  const n = await links.count();
  for (let i = 0; i < n; i++) {
    if (await links.nth(i).isVisible()) return links.nth(i);
  }
  throw new Error(`no visible "${name}" job card found on the Day Allocation board`);
}

let fx: Fixture;

test.describe("Office — Schedule & Allocation: Day Allocation (Job Board)", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("resources rail, week navigation, and assign-staff/vehicle both write appointment_assignments", async ({
    page,
  }) => {
    await step("open Day Allocation", page, async () => {
      await page.goto("/schedule?tab=alloc");
      await expect(page.getByRole("heading", { name: "Schedule & Allocation" })).toBeVisible();
      await expect(page.getByRole("tab", { name: /Day Allocation/i })).toHaveAttribute("aria-selected", "true");
    });

    await step("resources rail lists the active staff/vehicle pool — truth-of-UI vs SQL", page, async () => {
      const sb = adminClient();
      const [{ count: staffCount }, { count: vehicleCount }] = await Promise.all([
        sb.from("staff").select("*", { count: "exact", head: true }).eq("is_active", true),
        sb.from("vehicles").select("*", { count: "exact", head: true }).eq("is_active", true),
      ]);

      // The resource rail is the only "aside" that mentions STAFF/VEHICLES —
      // the dashboard's own nav is also an <aside>, so scope past it.
      const rail = page.locator("aside").filter({ hasText: "VEHICLES" });
      await expect(rail).toBeVisible();
      await expect(rail.getByText(fx.staff.full_name, { exact: true })).toBeVisible();
      await expect(rail.getByText(fx.vehicle.name, { exact: true })).toBeVisible();

      // RailChip renders one row per staff/vehicle, no filtering — the row
      // count under each eyebrow heading must equal the active-row SQL count.
      const staffRows = rail.locator("p.eyebrow", { hasText: "Staff" }).locator("xpath=following-sibling::div[1]/*");
      const vehicleRows = rail
        .locator("p.eyebrow", { hasText: "Vehicles" })
        .locator("xpath=following-sibling::div[1]/*");
      await expect(staffRows).toHaveCount(staffCount ?? 0);
      await expect(vehicleRows).toHaveCount(vehicleCount ?? 0);
    });

    await step("week navigation moves forward and back to the same week", page, async () => {
      const weekLabel = page.getByTitle("Back to this week");
      const before = await weekLabel.innerText();
      await page.getByRole("button", { name: "Next week" }).click();
      await expect(weekLabel).not.toHaveText(before);
      await page.getByRole("button", { name: "Previous week" }).click();
      await expect(weekLabel).toHaveText(before);
    });

    await step("assign staff + vehicle to the marker job via the modal", page, async () => {
      const cardLink = await visibleCardLink(page, `${MARKER} Client`);
      await cardLink.scrollIntoViewIfNeeded();
      const card = cardLink.locator("xpath=ancestor::div[.//button[contains(., 'Assign staff')]][1]");
      await card.getByRole("button", { name: /Assign staff \/ vehicle/i }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: new RegExp(fx.staff.full_name, "i") }).click();
      await dialog.getByRole("button", { name: new RegExp(fx.vehicle.name, "i") }).click();
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByText("Assignments updated.")).toBeVisible();
    });

    await step("SQL read-back: appointment_assignments carries the exact staff+vehicle ids", page, async () => {
      const sb = adminClient();
      const { data: rows, error } = await sb
        .from("appointment_assignments")
        .select("staff_id, vehicle_id")
        .eq("appointment_id", fx.appointmentId);
      expect(error).toBeNull();
      const staffIds = (rows ?? []).map((r) => r.staff_id).filter(Boolean);
      const vehicleIds = (rows ?? []).map((r) => r.vehicle_id).filter(Boolean);
      expect(staffIds).toContain(fx.staff.id);
      expect(vehicleIds).toContain(fx.vehicle.id);
    });

    await step("after reload, the assigned chips are visible on the board", page, async () => {
      await page.reload();
      const cardLink = await visibleCardLink(page, `${MARKER} Client`);
      const card = cardLink.locator("xpath=ancestor::div[.//button[contains(., 'Assign staff')]][1]");
      await expect(card.getByText(fx.staff.full_name, { exact: true })).toBeVisible();
      await expect(card.getByText(fx.vehicle.name, { exact: true })).toBeVisible();
    });
  });
});
