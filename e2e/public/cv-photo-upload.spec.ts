import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * /cv/<token> — the customer self-fill cubic survey's photo widget
 * (QA-20260827-04): a customer can attach a photo of their own move through
 * the token-authenticated link, with no login. Genuinely never had a
 * permanent spec — public/cubic.spec.ts proves the search-first item builder
 * loads and is interactive but never touches the photo control at all.
 *
 * Proven live against staging by the QA audit (customer role-agent,
 * 2026-09-03, `f8d1e44`): a marker cubic_surveys row, a real 293-byte JPEG
 * uploaded through `<input id="cv-survey-photos">`, service-role read-back of
 * `survey_photos` (`customer_uploaded=true`, `storage_path` set) plus a
 * direct bucket download byte-identical to the source file, and the SAME
 * photo loadable on the admin review page for that survey. This spec
 * reuses that exact seed/upload/read-back shape.
 *
 * Self-seeds its own marker client/lead/cubic_surveys row (no reusable
 * seed-data.ts fixture exists for this — /cv links are minted per-lead) and
 * tears everything down, INCLUDING the `activities` row
 * `POST /cv/<token>/photos` writes on a survey's first customer photo
 * (`insertCustomerPhoto`'s `isFirst` timeline note) — a teardown that skips
 * it leaves the marker lead un-deletable (activities.lead_id has no ON
 * DELETE CASCADE), which is exactly what a scratch validation of this
 * recipe hit before this file was written.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-CV-PHOTO-${Date.now()}`;
const SHARE_TOKEN = `${MARKER}-token`.toLowerCase();

// A 1x1 red pixel PNG — small enough to keep the upload instant, real enough
// to carry genuine PNG magic bytes through the route's byte-sniff.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface Fixture {
  clientId: string;
  leadId: string;
  surveyId: string;
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER, postcode_home: "SP7 8AA" })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "quoted",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900111",
      email: "qa-sentinel-sink@marleymoves.test",
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "3 bedroom",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr || !lead) throw new Error(`seed lead: ${lErr?.message ?? "no row returned"}`);

  const { data: survey, error: sErr } = await sb
    .from("cubic_surveys")
    .insert({ lead_id: lead.id, client_id: client.id, share_token: SHARE_TOKEN, status: "draft", notes: MARKER })
    .select("id")
    .single();
  if (sErr || !survey) throw new Error(`seed cubic_surveys: ${sErr?.message ?? "no row returned"}`);

  return { clientId: client.id as string, leadId: lead.id as string, surveyId: survey.id as string };
}

async function teardown(fx: Fixture) {
  const sb = adminClient();
  const problems: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) problems.push(`${label}: ${error.message}`);
  };

  // The `surveys` row (survey_photos.survey_id points here, NOT at
  // cubic_surveys) is created lazily by ensure_customer_survey_row on first
  // upload, keyed off lead_id — look it up rather than assuming it exists.
  const { data: surveyRows } = await sb.from("surveys").select("id").eq("lead_id", fx.leadId);
  for (const row of surveyRows ?? []) {
    check("survey_photos", (await sb.from("survey_photos").delete().eq("survey_id", row.id)).error);
  }
  if (surveyRows?.length) {
    check(
      "surveys",
      (await sb.from("surveys").delete().in("id", surveyRows.map((r) => r.id))).error,
    );
  }
  // insertCustomerPhoto's isFirst branch writes a lead timeline note —
  // activities.lead_id has no ON DELETE CASCADE, so a lead delete is blocked
  // until this is cleared too.
  check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
  check("cubic_surveys", (await sb.from("cubic_surveys").delete().eq("id", fx.surveyId)).error);
  check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);

  const { count } = await sb.from("clients").select("*", { count: "exact", head: true }).eq("notes", MARKER);
  if (count) problems.push(`clients: ${count} marker row(s) still present after delete`);
  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

let fx: Fixture | null = null;

test.describe.serial("Customer — /cv photo upload (QA-20260827-04)", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("attach a photo through the token link, with no login", async ({ page }) => {
    await step("the token loads the customer's survey", page, async () => {
      await page.goto(`/cv/${SHARE_TOKEN}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: /What's moving/i })).toBeVisible();
    });

    await step("attach a photo through the real file input", page, async () => {
      const fileInput = page.locator("#cv-survey-photos");
      await fileInput.setInputFiles({
        name: "moving-photo.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });
      await expect(page.getByAltText("Survey photo you added")).toBeVisible({ timeout: 15_000 });
    });

    await step("the DB shows a customer-attributed photo pointing at a real object", page, async () => {
      const sb = adminClient();
      const { data: surveyRow, error: sErr } = await sb
        .from("surveys")
        .select("id")
        .eq("lead_id", fx!.leadId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      expect(sErr).toBeNull();
      expect(surveyRow?.id).toBeTruthy();

      const { data: photos, error: pErr } = await sb
        .from("survey_photos")
        .select("storage_path, customer_uploaded, category")
        .eq("survey_id", surveyRow!.id);
      expect(pErr).toBeNull();
      expect(photos).toHaveLength(1);
      expect(photos![0].customer_uploaded).toBe(true);
      expect(photos![0].category).toBe("cubic");

      const { data: object, error: dlErr } = await sb.storage.from("survey-photos").download(photos![0].storage_path);
      expect(dlErr).toBeNull();
      const bytes = Buffer.from(await object!.arrayBuffer());
      expect(bytes.equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true);
    });
  });

  test("a bad token 404s", async ({ page }) => {
    const res = await page.goto("/cv/e2e-not-a-real-cv-token-9999");
    expect(res?.status()).toBe(404);
  });
});
