import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * /board — Pipeline Board (kanban). Seeds marker leads at three different
 * funnel stages (website_enquiry, quoted, confirmed), confirms each renders
 * in the matching column, and that the column counts match SQL truth once
 * narrowed to this spec's own marker rows (the board's default view is the
 * current Mon–Sun enquiry week, so submitted_at is stamped "now" to land
 * inside it — otherwise the cards would be filtered out by default).
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker leads",
);

const MARKER = `E2E-BOARD-KANBAN-${Date.now()}`;

const SEEDS = [
  { status: "website_enquiry", column: "Enquiry", name: `${MARKER} enquiry` },
  { status: "quoted", column: "Quoted", name: `${MARKER} quoted` },
  { status: "confirmed", column: "Confirmed", name: `${MARKER} confirmed` },
] as const;

interface Fixture {
  clientId: string;
  leadIds: string[];
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);
  const clientId = client.id as string;

  const now = new Date().toISOString();
  const leadIds: string[] = [];
  for (const s of SEEDS) {
    const { data, error } = await sb
      .from("leads")
      .insert({
        client_id: clientId,
        status: s.status,
        entry_channel: "manual",
        source_system: "marley_ops",
        name: s.name,
        phone: "07700900111",
        email: "qa-sentinel-sink@marleymoves.test",
        from_postcode: "SP7 8AA",
        to_postcode: "BH21 4DJ",
        notes: MARKER,
        submitted_at: now,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed lead (${s.status}): ${error?.message ?? "no row returned"}`);
    leadIds.push(data.id as string);
  }
  return { clientId, leadIds };
}

async function teardown(fx: Fixture) {
  const sb = adminClient();
  const problems: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) problems.push(`${label}: ${error.message}`);
  };
  for (const leadId of fx.leadIds) {
    check("activities", (await sb.from("activities").delete().eq("lead_id", leadId)).error);
    check("leads", (await sb.from("leads").delete().eq("id", leadId)).error);
  }
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);
  const { count } = await sb.from("leads").select("*", { count: "exact", head: true }).eq("notes", MARKER);
  if (count) problems.push(`leads: ${count} marker row(s) still present after delete`);
  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

let fx: Fixture | null = null;

test.describe("Office — Pipeline Board (kanban)", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("marker leads render in the correct column, counts match SQL", async ({ page }) => {
    await step("open the board and narrow to this spec's marker leads", page, async () => {
      await page.goto("/board");
      await expect(page.getByRole("heading", { name: "Pipeline Board" })).toBeVisible();
      // Narrow the whole board to just this run's rows so column counts are
      // comparable to SQL without being thrown off by any other seeded/live
      // data or a concurrent run's own marker rows (a prior run hit exactly
      // that false mismatch scoping to the wrong set).
      await page.getByLabel("Search board").fill(MARKER);
    });

    await step("each marker lead sits in the column its status maps to", page, async () => {
      for (const s of SEEDS) {
        const card = page.getByText(s.name, { exact: true }).first();
        await expect(card).toBeVisible();
        const columnLabel = await card.evaluate((el) => {
          let n: HTMLElement | null = el as HTMLElement;
          while (n && n.tagName !== "SECTION") n = n.parentElement;
          const header = n?.querySelector("header span.font-semibold");
          return header?.textContent?.trim() ?? null;
        });
        expect(columnLabel).toBe(s.column);
      }
    });

    await step("column counts, scoped to marker leads, match SQL", page, async () => {
      // SQL truth, scoped to exactly the leads this spec seeded — never the
      // whole column, which a concurrent agent's own marker row can inflate.
      const sb = adminClient();
      const { data, error } = await sb.from("leads").select("status").eq("notes", MARKER);
      expect(error).toBeNull();
      const sqlCounts = new Map<string, number>();
      for (const row of data ?? []) sqlCounts.set(row.status, (sqlCounts.get(row.status) ?? 0) + 1);

      for (const s of SEEDS) {
        // With the search narrowed to MARKER, the visible count badge on this
        // status's column is exactly this spec's own rows in that status.
        const section = page.locator("section", { has: page.getByText(s.column, { exact: true }) }).first();
        const badge = section.locator("header span.rounded-pill");
        await expect(badge).toHaveText(String(sqlCounts.get(s.status) ?? 0));
      }
    });
  });
});
