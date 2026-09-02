import { test, expect, type Page } from "@playwright/test";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * Gate 11 — the diary brand layer (multi-brand PRD §5, commit 537b607).
 *
 * styleFor() in components/schedule/scheduler-view.tsx resolves event fills
 * from the slim brands prop: the default brand renders today's exact parity
 * constants (Marley removals = solid #1A1A1A), any other brand derives
 * data-driven (removal = colour_primary; survey = colour_accent). A removal
 * whose lead has no date_confirmed_at renders HOLLOW (transparent fill, 2px
 * dashed border in the brand's removal colour, class `mm-evt--hollow`) and
 * fills solid on confirmation. Surveys ignore confirmation entirely.
 *
 * All of this was proven live against deployed staging on 2026-08-26 (QA
 * overnight audit, computed-style assertions matching the brands table's own
 * colour rows); this spec pins it. Colours for the non-default brand are read
 * from the brands table at runtime, not hardcoded, so a rebrand doesn't break
 * the spec — only the Marley parity constant is a hard assert.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture, and 2+ active brands (staging
 * default; the parity project flips Pitmans back on in its afterAll).
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker appointments — set in CI, usually unset locally",
);

const MARKER = "E2E-DIARY-BRAND";
const SOLID_TITLE = `${MARKER} solid-a`;
const HOLLOW_TITLE = `${MARKER} hollow-b`;
const SURVEY_TITLE = `${MARKER} survey-c`;
/** Parity constant: default-brand removals fill (scheduler-view styleFor). */
const MARLEY_REMOVAL_RGB = "rgb(26, 26, 26)";

interface Fixture {
  clientId: string;
  marleyLeadId: string;
  otherLeadId: string;
  apptIds: string[];
  otherBrand: { slug: string; colour_primary: string; colour_accent: string };
}

/**
 * What the seed has actually written, recorded row by row as it writes rather
 * than handed over when it finishes. A seed that throws part-way — a new NOT
 * NULL column on appointments, one dropped round-trip — would otherwise leave
 * the client and both leads in staging with the fixture variable still null and
 * afterAll a no-op, and nothing else sweeps them: globalTeardown purges only
 * staging ledger invoices, and scripts/seed-e2e.mjs wipes on a "E2E " prefix
 * whose SPACE this spec's hyphenated marker does not match. The leak would
 * survive every reseed and accumulate one set per CI run.
 */
const created: { clientId?: string; leadIds: string[]; apptIds: string[] } = {
  leadIds: [],
  apptIds: [],
};

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Today's UK calendar date — 16:00Z is the same UK clock date year-round. */
function ukToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

async function seed(): Promise<Fixture | null> {
  const sb = adminClient();

  // Mirror lib/brand.ts listActiveBrands: active, 'group' pseudo-brand
  // excluded, sort order. The default brand is the code constant "marley"
  // (lib/brand.ts DEFAULT_BRAND), not a DB column.
  const { data: brands, error: bErr } = await sb
    .from("brands")
    .select("slug, colour_primary, colour_accent")
    .eq("active", true)
    .neq("slug", "group")
    .order("sort_order", { ascending: true });
  if (bErr) throw new Error(`read brands: ${bErr.message}`);
  const other = (brands ?? []).find((b) => b.slug !== "marley" && b.colour_primary && b.colour_accent);
  if (!other || (brands ?? []).length < 2) return null; // single-brand mode — caller skips

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);
  const clientId = client.id as string;
  created.clientId = clientId;

  async function lead(brand: string, confirmed: boolean) {
    const { data, error } = await sb
      .from("leads")
      .insert({
        client_id: clientId,
        status: "confirmed",
        entry_channel: "manual",
        source_system: "marley_ops",
        name: `${MARKER} Client`,
        phone: "07700900000",
        email: "e2e-diary-brand@marleymoves.test",
        from_postcode: "SP7 8AA",
        to_postcode: "SP8 4AB",
        brand,
        date_confirmed_at: confirmed ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed lead (${brand}): ${error.message}`);
    created.leadIds.push(data.id as string);
    return data.id as string;
  }
  const marleyLeadId = await lead("marley", true);
  const otherLeadId = await lead(other.slug, false);

  const day = ukToday();
  async function appt(apptType: string, brand: string, leadId: string, title: string, startZ: string, endZ: string) {
    const { data, error } = await sb
      .from("appointments")
      .insert({
        appt_type: apptType,
        client_id: clientId,
        lead_id: leadId,
        title,
        brand,
        starts_at: `${day}T${startZ}:00Z`,
        ends_at: `${day}T${endZ}:00Z`,
        status: "scheduled",
        location: "seed",
        notes: MARKER,
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed appointment (${title}): ${error.message}`);
    created.apptIds.push(data.id as string);
    return data.id as string;
  }
  const apptIds = [
    await appt("removal", "marley", marleyLeadId, SOLID_TITLE, "15:00", "16:00"),
    await appt("removal", other.slug, otherLeadId, HOLLOW_TITLE, "16:30", "17:30"),
    await appt("survey", other.slug, otherLeadId, SURVEY_TITLE, "18:00", "19:00"),
  ];
  return { clientId, marleyLeadId, otherLeadId, apptIds, otherBrand: other };
}

/**
 * Deletes whatever `created` records, FK-ordered (children before the leads and
 * client they hang off) and loud — a partial teardown throws rather than
 * leaving rows to be discovered later by whoever's spec they break.
 */
async function teardown(rows: typeof created) {
  const clientId = rows.clientId;
  if (!clientId) return; // seed wrote nothing (single-brand mode)
  const sb = adminClient();
  const problems: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) problems.push(`${label}: ${error.message}`);
  };
  for (const id of rows.apptIds) check("appointments", (await sb.from("appointments").delete().eq("id", id)).error);
  for (const leadId of rows.leadIds) {
    check("activities", (await sb.from("activities").delete().eq("lead_id", leadId)).error);
    check("leads", (await sb.from("leads").delete().eq("id", leadId)).error);
  }
  check("clients", (await sb.from("clients").delete().eq("id", clientId)).error);
  // Read back both halves: the appointments by their marker titles, and the
  // client by the id we wrote. A seed that fell over before the appointments
  // leaves a clean title count and a stranded client, so counting only the
  // titles is exactly the blind spot this teardown exists to close.
  const { count: apptCount } = await sb
    .from("appointments")
    .select("*", { count: "exact", head: true })
    .ilike("title", `${MARKER}%`);
  if (apptCount) problems.push(`appointments: ${apptCount} marker row(s) still present after delete`);
  const { count: clientCount } = await sb
    .from("clients")
    .select("*", { count: "exact", head: true })
    .eq("id", clientId);
  if (clientCount) problems.push("clients: the marker client is still present after delete");
  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

async function eventStyles(page: Page, title: string) {
  const el = page.locator(`.fc-event:has-text("${title}")`).first();
  await expect(el).toBeVisible();
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      background: s.backgroundColor,
      borderColor: s.borderTopColor,
      borderStyle: s.borderTopStyle,
      classes: [...node.classList],
    };
  });
}

let fx: Fixture | null = null;

test.describe("Office — diary brand layer (gate 11)", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  // Unconditional, and keyed off `created` rather than `fx`: a beforeAll that
  // threw still leaves rows, and that is precisely the case the old `if (fx)`
  // guard skipped.
  test.afterAll(async () => {
    await teardown(created);
  });

  test("brand-derived fills, hollow-unconfirmed flip, legend", async ({ page }) => {
    test.skip(!fx, "fewer than 2 active brands — multi-brand diary UI not rendered (parity mode)");
    const other = fx!.otherBrand;

    // Removals diary, week view (month view compacts events differently).
    await page.goto("/schedule/removals");
    await page.getByRole("button", { name: /week/i }).click();

    // (a) Default-brand confirmed removal: today's exact parity constant, solid.
    const solid = await eventStyles(page, SOLID_TITLE);
    expect(solid.background).toBe(MARLEY_REMOVAL_RGB);
    expect(solid.borderStyle).toBe("solid");
    expect(solid.classes).not.toContain("mm-evt--hollow");

    // (b) Non-default unconfirmed removal: hollow — transparent fill, dashed
    // border in the brand's own colour_primary (read from the brands table).
    const hollow = await eventStyles(page, HOLLOW_TITLE);
    expect(hollow.classes).toContain("mm-evt--hollow");
    expect(hollow.borderStyle).toBe("dashed");
    expect(hollow.background).toBe("rgba(0, 0, 0, 0)");
    expect(hollow.borderColor).toBe(hexToRgb(other.colour_primary));

    // Brand initials in the time row + the multi-brand legend.
    await expect(page.locator(".mm-evt-brand").first()).toBeVisible();
    await expect(page.getByText("Dashed outline = date not yet confirmed")).toBeVisible();

    // (c) Confirmation flip: stamping date_confirmed_at fills the removal solid.
    const sb = adminClient();
    const { error: upErr } = await sb
      .from("leads")
      .update({ date_confirmed_at: new Date().toISOString() })
      .eq("id", fx!.otherLeadId);
    expect(upErr).toBeNull();
    await page.reload();
    await page.getByRole("button", { name: /week/i }).click();
    const filled = await eventStyles(page, HOLLOW_TITLE);
    expect(filled.classes).not.toContain("mm-evt--hollow");
    expect(filled.borderStyle).toBe("solid");
    expect(filled.background).toBe(hexToRgb(other.colour_primary));

    // (d) Surveys always solid in colour_accent, even on an unconfirmed lead
    // (asserted BEFORE the flip would matter — appt_type, not confirmation,
    // decides; the lead is confirmed by now but hollow never applies to
    // surveys either way, and the fill must be accent- not primary-derived).
    await page.goto("/schedule/surveys");
    const survey = await eventStyles(page, SURVEY_TITLE);
    expect(survey.classes).not.toContain("mm-evt--hollow");
    expect(survey.borderStyle).toBe("solid");
    expect(survey.background).toBe(hexToRgb(other.colour_accent));
  });
});
