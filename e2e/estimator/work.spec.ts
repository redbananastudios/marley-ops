import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";
import { E2E_USERS } from "../fixtures/seed-data";

/**
 * Leads scoped to own / "Mine" preset (closes the estimator/work.spec.ts gap
 * tracked ⬜ in e2e/COVERAGE.md line 61).
 *
 * app/(dashboard)/leads/page.tsx fetches EVERY lead for the active brand(s) —
 * there is no server-side/RLS scoping by estimator — and hands it to
 * components/leads/leads-board.tsx, whose client-side "Mine" preset chip does
 * the actual filtering: `matchesPreset(l, "mine") = l.estimator_id === meId`
 * (meId = the signed-in user's id, page.tsx `meId={user?.id ?? null}`). This
 * spec proves that filter really discriminates by seeding two marker leads —
 * one with estimator_id = the signed-in estimator's own profile id, one with
 * estimator_id = null — and asserting: with "All" active both are visible,
 * with "Mine" active only the assigned one is. Without this, the preset could
 * silently show every lead regardless of assignment and nothing would catch it
 * (the same shape of bug as the office/quotes.spec.ts strict-mode note in
 * journey.spec.ts, but for scoping rather than a locator).
 *
 * "Mine" ignores lead status entirely (see matchesPreset above) but the
 * *default* preset on load is "new" (website_enquiry only, see leads-board.tsx
 * "Peter, 2026-08-14" comment) — so this spec explicitly clicks the "All" chip
 * before checking both are present, exactly the way a human would need to. The
 * chip's accessible name is "All <count>" (a nested count badge); the
 * brand-filter toggle also renders a bare "All" with no digits, so the
 * locators below require a trailing number to avoid that collision (found
 * live: `getByRole("button", { name: "All", exact: true })` matches the brand
 * toggle instead of the preset chip).
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job
 * exports both) to seed/tear down its own marker leads, and needs a resolvable
 * profiles row for E2E_USERS.estimator.email (the persistent estimator fixture
 * auth.setup.ts signs in as) to get that estimator's real profile id — the
 * same id the "Mine" preset compares against.
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

test.skip(!dbReady, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker leads");

const MARKER = "E2E-ESTIMATOR-WORK";
const ts = Date.now();
const MINE_NAME = `${MARKER} Mine ${ts}`;
const NOT_MINE_NAME = `${MARKER} NotMine ${ts}`;

interface Fixture {
  clientId: string;
  mineLeadId: string;
  notMineLeadId: string;
}

async function resolveEstimatorId(): Promise<string> {
  const sb = db();
  const { data, error } = await sb.from("profiles").select("id").eq("email", E2E_USERS.estimator.email).maybeSingle();
  if (error) throw new Error(`resolving estimator profile: ${error.message}`);
  if (!data?.id) {
    throw new Error(
      `No profiles row for ${E2E_USERS.estimator.email} — the persistent estimator fixture must exist for this spec to know which estimator_id "Mine" should match.`,
    );
  }
  return data.id;
}

async function seed(estimatorId: string): Promise<Fixture> {
  const sb = db();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client ${ts}`, postcode_home: "SP7 8AA", notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const leadBase = {
    client_id: client.id,
    status: "quoted",
    entry_channel: "manual",
    source_system: "marley_ops",
    from_postcode: "SP7 8AA",
    to_postcode: "BA1 1AA",
    brand: "marley",
    submitted_at: new Date().toISOString(),
  };

  const { data: mine, error: mErr } = await sb
    .from("leads")
    .insert({ ...leadBase, name: MINE_NAME, phone: "07700900301", email: `e2e-work-mine-${ts}@marleymoves.test`, notes: MARKER, estimator_id: estimatorId })
    .select("id")
    .single();
  if (mErr) throw new Error(`seed mine lead: ${mErr.message}`);

  const { data: notMine, error: nErr } = await sb
    .from("leads")
    .insert({ ...leadBase, name: NOT_MINE_NAME, phone: "07700900302", email: `e2e-work-notmine-${ts}@marleymoves.test`, notes: MARKER, estimator_id: null })
    .select("id")
    .single();
  if (nErr) throw new Error(`seed not-mine lead: ${nErr.message}`);

  return { clientId: client.id, mineLeadId: mine.id, notMineLeadId: notMine.id };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = db();
  const problems: string[] = [];
  const check = (table: string, error: { message: string } | null) => {
    if (error) problems.push(`${table}: ${error.message}`);
  };

  check("activities", (await sb.from("activities").delete().in("lead_id", [fx.mineLeadId, fx.notMineLeadId])).error);
  check("communications", (await sb.from("communications").delete().in("lead_id", [fx.mineLeadId, fx.notMineLeadId])).error);
  check("leads", (await sb.from("leads").delete().in("id", [fx.mineLeadId, fx.notMineLeadId])).error);
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);

  const { count } = await sb.from("leads").select("*", { count: "exact", head: true }).in("id", [fx.mineLeadId, fx.notMineLeadId]);
  if (count) problems.push(`leads: ${count} row(s) still present after delete`);

  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

test.describe("Estimator — leads scoped to own / Mine preset", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test('"Mine" shows only the lead assigned to me; "All" shows both', async ({ page }) => {
    const estimatorId = await resolveEstimatorId();
    fx = await seed(estimatorId);

    await step("switch to Table view for a plain-text read of every row", page, async () => {
      await page.goto("/leads");
      await page.getByRole("button", { name: "Table", exact: true }).click();
    });

    const allChip = page.getByRole("button", { name: /^All\s+\d+$/ });
    const mineChip = page.getByRole("button", { name: /^Mine\s+\d+$/ });

    await step('with "All" active, both marker leads are visible', page, async () => {
      await allChip.click();
      await expect(page.getByRole("main").getByText(MINE_NAME, { exact: false })).toBeVisible();
      await expect(page.getByRole("main").getByText(NOT_MINE_NAME, { exact: false })).toBeVisible();
    });

    await step('with "Mine" active, only the assigned lead is visible', page, async () => {
      await mineChip.click();
      await expect(page.getByRole("main").getByText(MINE_NAME, { exact: false })).toBeVisible();
      await expect(page.getByRole("main").getByText(NOT_MINE_NAME, { exact: false })).toHaveCount(0);
    });

    await step("SQL read-back: estimator_id matches exactly what was seeded", page, async () => {
      const { data, error } = await db().from("leads").select("id, estimator_id").in("id", [fx!.mineLeadId, fx!.notMineLeadId]);
      if (error) throw new Error(`read-back leads: ${error.message}`);
      const mine = data!.find((l) => l.id === fx!.mineLeadId);
      const notMine = data!.find((l) => l.id === fx!.notMineLeadId);
      expect(mine?.estimator_id).toBe(estimatorId);
      expect(notMine?.estimator_id).toBeNull();
    });
  });
});
