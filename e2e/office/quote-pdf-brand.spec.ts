import { test, expect } from "@playwright/test";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { submitUntil } from "../fixtures/ui";

/**
 * Gate 14 — brand-specific quote PDFs (multi-brand PRD §5, commit daddb44).
 *
 * A Pitmans-brand quote's downloaded PDF filename must carry the "Pitmans-"
 * prefix (`lib/quote/pdf-client.ts`); a Marley-brand quote's filename must stay
 * exactly as before (no prefix). This only pins the mechanically stable part of
 * gate 14 — the download itself and its filename — not the PDF's internal
 * colours/text (proven live once by the 2026-08-26 audit against real staging
 * output: Pitmans blue #2B2B76 fill, "trading name of MarleyMoves Ltd" legal
 * line stated once per page, shared "MARLEYMOVES LTD" bank details on both
 * brands; see qa/state.json for that evidence). No PDF-parsing dependency
 * exists in this repo yet, so deep content assertions are left for a future
 * spec if one gets added.
 *
 * Filename intentionally does NOT assert the ref prefix (PMR vs MMR) — that's
 * QA-20260825-03's territory (`quote-brand-ref.spec.ts`), a separate known bug
 * where a Pitmans quote currently mints an MM-prefixed ref. This spec's
 * "Pitmans-" filename prefix is controlled independently by `quotes.brand`,
 * not by the ref, so it holds regardless of that bug's fix state.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports both)
 * to seed/tear down its own marker fixtures.
 */
test.skip(!E2E_DB_READY, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker leads");

const MARKER = "E2E-QUOTE-PDF-BRAND";

interface Fixture {
  clientId: string;
  leadId: string;
}

async function seed(brand: "marley" | "pitmans"): Promise<Fixture> {
  const sb = adminClient();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} ${brand} Client`, notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      brand,
      status: "quoted",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} ${brand} Lead`,
      phone: "07700900000",
      email: `e2e-quote-pdf-brand-${brand}@marleymoves.test`,
      from_postcode: "DT11 7AA",
      to_postcode: "SP7 8AA",
      property_size: "2 bedroom",
      media_consent: "unset",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  return { clientId: client.id, leadId: lead.id };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = adminClient();
  await sb.from("activities").delete().eq("lead_id", fx.leadId);
  await sb.from("quotes").delete().eq("lead_id", fx.leadId);
  await sb.from("leads").delete().eq("id", fx.leadId);
  await sb.from("clients").delete().eq("id", fx.clientId);
}

/**
 * Step 1 (Customer) is pre-valid from the lead's own name/email, so Continue
 * advances freely. Step 2 (Job details) gates BOTH Continue and any forward
 * progress-dot jump behind step2Valid (route.deadMiles/jobMiles set) — the
 * builder won't let a jump straight to Review & send skip a route calc that
 * was never run (quote-builder.tsx goToStep). Fill both addresses for real
 * and run the calc, exactly like a human would, before jumping ahead.
 */
async function advanceToReviewStep(page: import("@playwright/test").Page) {
  await submitUntil(page, {
    click: page.getByRole("button", { name: "Continue" }),
    expected: page.getByText(/Step 2 \/ 7/i),
  });

  await page.locator("#q-collect-line1").fill("1 Blandford Road");
  await page.locator("#q-collect-postcode").fill("DT11 7AA");
  await page.locator("#q-dest-line1").fill("2 Bell Street");
  await page.locator("#q-dest-postcode").fill("SP7 8AA");

  await page.getByRole("button", { name: /Calculate route & mileage/i }).click();
  await expect(page.getByText("Route breakdown", { exact: true })).toBeVisible({ timeout: 20_000 });

  await submitUntil(page, {
    click: page.getByRole("button", { name: /Step 7: Review & send/i }),
    expected: page.getByText(/Step 7 \/ 7/i),
  });
}

test.describe("Office — quote PDF filename carries the quote's brand", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("a pitmans-brand quote downloads as Pitmans-Quote-<ref>.pdf", async ({ page }) => {
    fx = await seed("pitmans");

    await page.goto(`/quotes/new?leadId=${fx.leadId}`);
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/);
    await advanceToReviewStep(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download PDF/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^Pitmans-Quote-.+\.pdf$/);

    const sb = adminClient();
    const { data: quote, error } = await sb
      .from("quotes")
      .select("brand")
      .eq("lead_id", fx.leadId)
      .single();
    if (error) throw new Error(`read back quote: ${error.message}`);
    expect(quote.brand).toBe("pitmans");
  });

  test("a marley-brand quote downloads as MarleyMoves-Quote-<ref>.pdf (parity, no prefix regression)", async ({
    page,
  }) => {
    fx = await seed("marley");

    await page.goto(`/quotes/new?leadId=${fx.leadId}`);
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/);
    await advanceToReviewStep(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download PDF/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^MarleyMoves-Quote-.+\.pdf$/);
    expect(download.suggestedFilename()).not.toMatch(/^Pitmans-/);
  });
});
