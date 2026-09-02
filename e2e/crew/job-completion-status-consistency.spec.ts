import { test, expect } from "@playwright/test";
import { adminClient, E2E_DB_READY } from "../fixtures/db";
import { E2E_MARKER, E2E_USERS } from "../fixtures/seed-data";

/**
 * QA-20260902-03: a job the crew's own list already marks "Done"
 * (`appointments.status = 'completed'`) can still show a live "Complete job"
 * button and no completed banner on its own detail page, because the detail
 * page decides completion from a `job_completions` row's existence instead
 * of `appointments.status` — the exact source the list itself uses. This is
 * the real shape the balance-settled auto-complete cron produces (it writes
 * `appointments.status` directly and never inserts `job_completions`).
 *
 * Seeds its own marker appointment (completed, no `job_completions` row)
 * against the persistent e2e-crew login, and tears it down by exact id.
 */
test.describe("Crew — job completion status consistency", () => {
  test.skip(!E2E_DB_READY, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");

  let leadId: string;
  let clientId: string;
  let appointmentId: string;

  test.beforeAll(async () => {
    const sb = adminClient();

    const { data: staff, error: staffErr } = await sb
      .from("staff")
      .select("id")
      .ilike("email", E2E_USERS.crew.email)
      .maybeSingle();
    if (staffErr) throw new Error(`Looking up crew staff row failed: ${staffErr.message}`);
    if (!staff?.id) throw new Error(`No staff row for ${E2E_USERS.crew.email} — re-run scripts/seed-e2e.mjs.`);

    const { data: client, error: clientErr } = await sb
      .from("clients")
      .insert({ name: `${E2E_MARKER} completion-status client`, notes: E2E_MARKER })
      .select("id")
      .single();
    if (clientErr || !client) throw new Error(`Seeding marker client failed: ${clientErr?.message}`);
    clientId = client.id;

    const { data: lead, error: leadErr } = await sb
      .from("leads")
      .insert({
        client_id: clientId,
        name: `${E2E_MARKER} Completion Status Lead`,
        status: "confirmed",
        from_address: "1 Sentinel Way",
        from_postcode: "SP7 8AA",
        to_address: "2 Sentinel Close",
        to_postcode: "BH21 4EE",
        notes: E2E_MARKER,
      })
      .select("id")
      .single();
    if (leadErr || !lead) throw new Error(`Seeding marker lead failed: ${leadErr?.message}`);
    leadId = lead.id;

    const startsAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { data: appt, error: apptErr } = await sb
      .from("appointments")
      .insert({
        lead_id: leadId,
        appt_type: "removal",
        status: "completed", // the auto-complete cron's shape: status flipped directly, no job_completions row
        starts_at: startsAt,
        ends_at: new Date(new Date(startsAt).getTime() + 4 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (apptErr || !appt) throw new Error(`Seeding marker appointment failed: ${apptErr?.message}`);
    appointmentId = appt.id;

    const { error: assignErr } = await sb
      .from("appointment_assignments")
      .insert({ appointment_id: appointmentId, staff_id: staff.id });
    if (assignErr) throw new Error(`Seeding marker assignment failed: ${assignErr.message}`);
  });

  test.afterAll(async () => {
    if (!E2E_DB_READY) return;
    const sb = adminClient();
    if (appointmentId) await sb.from("appointment_assignments").delete().eq("appointment_id", appointmentId);
    if (appointmentId) await sb.from("appointments").delete().eq("id", appointmentId);
    if (leadId) await sb.from("leads").delete().eq("id", leadId);
    if (clientId) await sb.from("clients").delete().eq("id", clientId);
  });

  test.skip(
    true,
    "QA-20260902-03: detail page reads job_completions instead of appointments.status, so an " +
      "auto-completed job (no job_completions row) still shows a live Complete-job button. " +
      "Un-skip once the repair PR makes the detail page treat appointments.status='completed' " +
      "as completed regardless of job_completions.",
  );
  test("an auto-completed job (no job_completions row) is not offered for completion again", async ({ page }) => {
    await page.goto(`/my-jobs/${appointmentId}`);
    // The list already treats this appointment as done purely on
    // `appointments.status === 'completed'` (lib/my-jobs/job-card.ts). The
    // detail page must agree, without requiring a job_completions row.
    await expect(page.getByRole("button", { name: /Complete job/i })).not.toBeVisible();
    await expect(page.getByText(/completed|job.?s done/i)).toBeVisible();
  });
});
