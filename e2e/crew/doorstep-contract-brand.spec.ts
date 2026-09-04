import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { getBrandTermsUrl, setBrandTermsUrl } from "../fixtures/brands";

/**
 * PR #228 (975cd49): the doorstep "Collect signature now" contract dialog
 * (components/crew/collect-contract-button.tsx, rendered from
 * app/my-jobs/[id]/page.tsx) used to link to Marley's hardcoded TERMS_URL
 * regardless of the job's own brand. The fix resolves the JOB's brand via
 * `pageTheme()` and passes `termsUrl` down as a prop, falling back to
 * Marley's constant only when brand resolution fails.
 *
 * `brands.pitmans.terms_url` is NULL on staging by default, which makes
 * `pageTheme()` fall back to Marley's literal terms URL regardless of
 * whether the fix is wired correctly — a false pass either way. So this spec
 * temporarily gives Pitmans a distinct marker `terms_url` (Settings > Brands'
 * "Terms link", a safe display field per house convention) for the duration
 * of the test, then restores exactly whatever value it read beforehand.
 *
 * Live-verified against staging 2026-09-04 by the QA audit (a Sonnet crew
 * role-agent drove this exact recipe through the real UI, plus a Marley
 * control proving the single-brand-default-is-literal invariant still
 * holds) before this file was written from that recipe. 0 findings.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture and flip the brand row — set in
 * CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-DOORSTEP-BRAND-${Date.now()}`;
const MARKER_TERMS_URL = `https://pitmans-terms.${MARKER.toLowerCase()}.example.com/terms`;
const CREW_EMAIL = process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test";

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
  appointmentId: string;
}

async function seedJob(brand: "pitmans" | "marley", crewStaffId: string): Promise<Fixture> {
  const sb = adminClient();
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} ${brand} Client`, notes: MARKER, postcode_home: "SP7 8AA" })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client (${brand}): ${cErr?.message ?? "no row returned"}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      brand,
      status: "confirmed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} ${brand} Client`,
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr || !lead) throw new Error(`seed lead (${brand}): ${lErr?.message ?? "no row returned"}`);

  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      lead_id: lead.id,
      client_id: client.id,
      quote_ref: `${MARKER}-${brand}`,
      brand,
      status: "accepted",
      subtotal: 900,
      grand_total: 900,
      agreed_price: 900,
      // Deliberately no `source` — NULL is not in lib/legacy.ts's
      // IMPORTED_SOURCES (["imve","pitmans"], a legacy CSV-import marker
      // unrelated to the `brand` column), so job-sheet-load's
      // `importedBooking()` check correctly treats this as a live booking
      // and lets the contract-flag logic run regardless of brand.
      accepted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (qErr || !quote) throw new Error(`seed quote (${brand}): ${qErr?.message ?? "no row returned"}`);
  // No `signatures` row (kind='contract') for this quote — that absence is
  // exactly what flips job-sheet-load's `contractSigned` to false and makes
  // the "Contract not signed yet" banner (and the button under test) render.

  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const { data: appt, error: aErr } = await sb
    .from("appointments")
    .insert({
      appt_type: "removal",
      client_id: client.id,
      lead_id: lead.id,
      brand,
      title: `${MARKER} ${brand} Client`,
      starts_at: startsAt,
      ends_at: new Date(new Date(startsAt).getTime() + 4 * 3_600_000).toISOString(),
      status: "scheduled",
      location: MARKER,
    })
    .select("id")
    .single();
  if (aErr || !appt) throw new Error(`seed appointment (${brand}): ${aErr?.message ?? "no row returned"}`);

  const { error: assignErr } = await sb
    .from("appointment_assignments")
    .insert({ appointment_id: appt.id, staff_id: crewStaffId });
  if (assignErr) throw new Error(`seed assignment (${brand}): ${assignErr.message}`);

  return { clientId: client.id as string, leadId: lead.id as string, quoteId: quote.id as string, appointmentId: appt.id as string };
}

async function teardownJob(fx: Fixture, brand: string) {
  const sb = adminClient();
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    problems = [];
    const check = (label: string, error: { message: string } | null) => {
      if (error) problems.push(`${brand} ${label}: ${error.message}`);
    };
    check("appointment_assignments", (await sb.from("appointment_assignments").delete().eq("appointment_id", fx.appointmentId)).error);
    check("appointments", (await sb.from("appointments").delete().eq("id", fx.appointmentId)).error);
    check("quotes", (await sb.from("quotes").delete().eq("id", fx.quoteId)).error);
    check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
    check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);
    const { count } = await sb.from("clients").select("*", { count: "exact", head: true }).eq("notes", MARKER).eq("id", fx.clientId);
    if (count) problems.push(`${brand} clients: ${count} marker row(s) still present after delete`);
    if (!problems.length) return;
    if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

let pitmansFx: Fixture | null = null;
let marleyFx: Fixture | null = null;
let priorPitmansTermsUrl: string | null = null;

test.describe.serial("Crew — doorstep contract dialog links to the JOB's brand terms, not always the default's", () => {
  test.beforeAll(async () => {
    const sb = adminClient();
    const { data: staff, error } = await sb.from("staff").select("id").ilike("email", CREW_EMAIL).maybeSingle();
    if (error || !staff) throw new Error(`could not resolve the standing e2e-crew staff row: ${error?.message ?? "not found"}`);

    priorPitmansTermsUrl = await getBrandTermsUrl("pitmans");
    await setBrandTermsUrl("pitmans", MARKER_TERMS_URL);

    pitmansFx = await seedJob("pitmans", staff.id);
    marleyFx = await seedJob("marley", staff.id);
  });

  test.afterAll(async () => {
    await setBrandTermsUrl("pitmans", priorPitmansTermsUrl);
    const restored = await getBrandTermsUrl("pitmans");
    if (restored !== priorPitmansTermsUrl) {
      throw new Error(`brands.pitmans.terms_url failed to restore: read back ${restored}, expected ${priorPitmansTermsUrl}`);
    }
    if (pitmansFx) await teardownJob(pitmansFx, "pitmans");
    if (marleyFx) await teardownJob(marleyFx, "marley");
  });

  test("a Pitmans job's contract dialog links to Pitmans' own terms", async ({ page }) => {
    await step("open the seeded Pitmans job and the doorstep contract dialog", page, async () => {
      await page.goto(`/my-jobs/${pitmansFx!.appointmentId}`);
      await expect(page.getByText("Contract not signed yet")).toBeVisible();
      await page.getByRole("button", { name: "Collect signature now" }).click();
      await expect(page.getByRole("heading", { name: "Contract signature" })).toBeVisible();
    });

    await step("the terms & conditions link is Pitmans' marker URL, not Marley's default", page, async () => {
      const link = page.getByRole("link", { name: "terms & conditions" });
      await expect(link).toHaveAttribute("href", MARKER_TERMS_URL);
    });
  });

  test("a Marley job's contract dialog still links to Marley's literal default (control)", async ({ page }) => {
    await step("open the seeded Marley job and the doorstep contract dialog", page, async () => {
      await page.goto(`/my-jobs/${marleyFx!.appointmentId}`);
      await expect(page.getByText("Contract not signed yet")).toBeVisible();
      await page.getByRole("button", { name: "Collect signature now" }).click();
      await expect(page.getByRole("heading", { name: "Contract signature" })).toBeVisible();
    });

    await step("the terms & conditions link is Marley's exact literal default", page, async () => {
      const link = page.getByRole("link", { name: "terms & conditions" });
      await expect(link).toHaveAttribute("href", "https://marleymoves.co.uk/terms-conditions/");
    });
  });
});
