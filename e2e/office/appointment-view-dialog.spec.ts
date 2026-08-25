import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * The existing-appointment VIEW dialog (components/schedule/appointment-view-dialog.tsx
 * + job-summary.tsx) — opened by clicking a calendar item on /schedule/removals or
 * /schedule/surveys. Distinct from the "New appointment" CREATE dialog office/schedule.spec.ts
 * already covers.
 *
 * Never had a permanent spec. Proven live against staging repeatedly by the QA audit
 * (qa/state.json admin.appointment_view_job_summary) — every panel field cross-checked
 * against SQL, genuinely price-free (money only behind "View full quote"), and the
 * notes two-hats holds: this panel's "Job notes" row and the diary's "Edit → Job notes"
 * both read/write appointments.notes, never appointments' own separate job_notes table
 * (that belongs to crew's CrewNotesCard, correctly not duplicated here).
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job exports
 * both) to seed and tear down its own marker fixture — this env usually doesn't have
 * them locally.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbReady = !!url && !!serviceKey;

function db() {
  if (!dbReady) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  if (url.includes("supabase.redbananastudios.com")) {
    throw new Error(`E2E refuses to touch the PRODUCTION Supabase host (${url}).`);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

test.skip(!dbReady, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker appointment");

const MARKER = "E2E-APPT-VIEW";
const APPT_NOTES = `${MARKER} job notes — fragile items, call on arrival`;

interface Fixture {
  clientId: string;
  leadId: string;
  apptId: string;
  staffId: string;
  vehicleId: string | null;
}

async function seed(): Promise<Fixture> {
  const sb = db();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, postcode_home: "SP7 8AA", notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "confirmed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900000",
      email: "e2e-appt-view@marleymoves.test",
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "2 bedroom",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  const { data: staff, error: sErr } = await sb
    .from("staff")
    .insert({ full_name: `${MARKER} Crew`, staff_role: "crew", is_active: true })
    .select("id")
    .single();
  if (sErr) throw new Error(`seed staff: ${sErr.message}`);

  const { data: vehicle } = await sb.from("vehicles").select("id, name").eq("is_active", true).limit(1).maybeSingle();

  const start = new Date(Date.now() + 86_400_000).toISOString();
  const { data: appt, error: aErr } = await sb
    .from("appointments")
    .insert({
      appt_type: "removal",
      client_id: client.id,
      lead_id: lead.id,
      title: `${MARKER} Client`,
      starts_at: start,
      ends_at: start,
      status: "scheduled",
      location: "seed",
      notes: APPT_NOTES,
    })
    .select("id")
    .single();
  if (aErr) throw new Error(`seed appointment: ${aErr.message}`);

  const { error: asErr } = await sb.from("appointment_assignments").insert([
    { appointment_id: appt.id, staff_id: staff.id },
    ...(vehicle ? [{ appointment_id: appt.id, vehicle_id: vehicle.id }] : []),
  ]);
  if (asErr) throw new Error(`seed appointment_assignments: ${asErr.message}`);

  return { clientId: client.id, leadId: lead.id, apptId: appt.id, staffId: staff.id, vehicleId: vehicle?.id ?? null };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = db();
  const problems: string[] = [];
  const check = (table: string, error: { message: string } | null) => {
    if (error) problems.push(`${table}: ${error.message}`);
  };

  check("appointment_assignments", (await sb.from("appointment_assignments").delete().eq("appointment_id", fx.apptId)).error);
  check("appointments", (await sb.from("appointments").delete().eq("id", fx.apptId)).error);
  check("staff", (await sb.from("staff").delete().eq("id", fx.staffId)).error);
  check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
  check("communications", (await sb.from("communications").delete().eq("lead_id", fx.leadId)).error);
  check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);

  const { count } = await sb.from("appointments").select("*", { count: "exact", head: true }).eq("id", fx.apptId);
  if (count) problems.push(`appointments: ${count} row(s) still present after delete`);

  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

test.describe("Office — appointment view dialog (job summary)", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("crew/vehicle and notes match the DB, and the panel stays price-free", async ({ page }) => {
    fx = await seed();
    const staffName = `${MARKER} Crew`;

    await step("open the marker appointment's view dialog from the removals diary", page, async () => {
      await page.goto("/schedule/removals");
      const event = page.locator(".fc-event").filter({ hasText: `${MARKER} Client` });
      await expect(event.first()).toBeVisible();
      await event.first().click();
    });

    const dialog = page.getByRole("dialog");
    await step("crew, vehicle and job notes match what was seeded", page, async () => {
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(staffName)).toBeVisible();
      if (fx!.vehicleId) {
        const { data: vehicle } = await db().from("vehicles").select("name").eq("id", fx!.vehicleId).single();
        if (vehicle?.name) await expect(dialog.getByText(vehicle.name, { exact: false })).toBeVisible();
      }
      await expect(dialog.getByText(APPT_NOTES, { exact: false })).toBeVisible();
    });

    await step("the panel never shows a price — money lives behind View full quote", page, async () => {
      const text = await dialog.innerText();
      expect(text).not.toContain("£");
    });

    await step("SQL read-back: appointments.notes is exactly what the panel showed", page, async () => {
      const { data: appt, error } = await db().from("appointments").select("notes").eq("id", fx!.apptId).single();
      if (error) throw new Error(`read-back appointments: ${error.message}`);
      expect(appt.notes).toBe(APPT_NOTES);
    });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
