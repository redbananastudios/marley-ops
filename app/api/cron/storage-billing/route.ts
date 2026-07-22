import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { getInvoiceStatus } from "@/lib/zoho";
import { raiseDueStorageInvoices } from "@/lib/storage/raise-storage-invoices";

/**
 * Storage billing (daily Vercel cron, ~08:00 UK). The raise loop lives in the
 * shared core lib/storage/raise-storage-invoices.ts (the release flow calls
 * the same code inline for one let, so "settled before goods leave" never
 * waits for the cron). This route adds the daily-only pieces: the
 * consolidated money alert and the unpaid-status refresh from Zoho.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UK = "Europe/London";

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  const run = await runCron("storage-billing", async () => {
    const admin = createAdminClient();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });

    const summary = await raiseDueStorageInvoices(admin, { todayIso: today });

    // A billing failure that isn't surfaced becomes a permanent under-bill. One
    // consolidated money alert (not one per period) so a full Zoho outage doesn't
    // flood the accounts desk.
    if (summary.billingFailures.length) {
      await sendOpsAlert(
        "Storage billing could not raise some invoices",
        [
          `${summary.billingFailures.length} storage ${summary.billingFailures.length === 1 ? "item" : "items"} failed on ${today}. Released periods retry automatically on the next run; any marked “NOT released” need manual attention.`,
          ...summary.billingFailures,
        ],
        "money",
      );
    }

    /* ---------------- refresh unpaid statuses ---------------- */
    let statusUpdated = 0;
    const { data: unpaid } = await admin
      .from("storage_invoices")
      .select("id, zoho_invoice_id")
      .eq("status", "sent")
      .not("zoho_invoice_id", "is", null)
      .order("updated_at", { ascending: true })
      .limit(25);
    for (const row of unpaid ?? []) {
      try {
        const status = await getInvoiceStatus(row.zoho_invoice_id!);
        if (status.status === "paid") {
          await admin.from("storage_invoices").update({ status: "paid" } as never).eq("id", row.id);
          statusUpdated++;
        } else if (status.status === "void") {
          await admin.from("storage_invoices").update({ status: "void" } as never).eq("id", row.id);
          statusUpdated++;
        }
      } catch (e) {
        // transient Zoho error — next run retries; log so a persistent one is visible
        log.warn("cron.storage-billing.status_refresh_failed", { invoiceId: row.zoho_invoice_id, ...errorContext(e) });
      }
    }

    return {
      today,
      raised: summary.raised,
      emailed: summary.emailed,
      statusUpdated,
      errors: summary.errors,
      billingFailures: summary.billingFailures,
    };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
