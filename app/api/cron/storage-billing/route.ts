import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { blindSweepFailure } from "@/lib/cron/blind-sweep";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { asProvider, getInvoiceStatus } from "@/lib/ledger";
import {
  raiseDueStorageInvoices,
  repairPendingStorageClaims,
  resendUnemailedStorageInvoices,
} from "@/lib/storage/raise-storage-invoices";

/**
 * Storage billing (daily Vercel cron, ~08:00 UK). The raise loop lives in the
 * shared core lib/storage/raise-storage-invoices.ts (the release flow calls
 * the same code inline for one let, so "settled before goods leave" never
 * waits for the cron). This route adds the daily-only pieces: the pending-claim
 * repair sweep (BEFORE the raise, so a claim stranded by yesterday's crash is
 * completed or released before it can block today's periods), the consolidated
 * money alerts, the stranded-handling-events check and the unpaid-status
 * refresh from Zoho.
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

    // Repair first: adopt/release claims stranded 'pending' by a crash between
    // the Zoho create and the DB write-back. Its alerts ride the same money
    // alert as billing failures below.
    const repair = await repairPendingStorageClaims(admin, { todayIso: today });

    const summary = await raiseDueStorageInvoices(admin, { todayIso: today });

    // Retry any invoice raised on an earlier run whose customer email never
    // went out. This path has no dispatchComm behind it (there is no lead or
    // quote to hang a communications row on), so this sweep IS its retry layer —
    // without it a single Resend blip at the billing hour leaves a customer
    // billed in Zoho with nothing in their inbox, permanently.
    const resend = await resendUnemailedStorageInvoices(admin, { todayIso: today });

    // A ledger read failed — NOTHING was raised (raising on partial data
    // double-bills). Alert the money desk and mark the run failed so the
    // watchdog and /automations cannot show a false green.
    if (summary.fatal) {
      await sendOpsAlert(
        "Storage billing aborted — ledger read failed",
        [
          `The ${today} run stopped before raising anything: ${summary.fatal}`,
          "No invoices were raised on partial data; the next run retries automatically.",
          ...repair.alerts,
          ...resend.alerts,
        ],
        "money",
      );
      return {
        ok: false,
        error: summary.fatal,
        today,
        fatal: summary.fatal,
        adopted: repair.adopted,
        released: repair.released,
        raised: summary.raised,
        emailed: summary.emailed,
        errors: summary.errors,
        billingFailures: summary.billingFailures,
        repairAlerts: repair.alerts,
        resentInvoiceEmails: resend.resent,
        resendAlerts: resend.alerts,
      };
    }

    // A billing failure that isn't surfaced becomes a permanent under-bill. One
    // consolidated money alert (not one per period) so a full Zoho outage doesn't
    // flood the accounts desk. Repair-sweep alerts merge in here.
    const failures = [...repair.alerts, ...resend.alerts, ...summary.billingFailures];
    if (failures.length) {
      await sendOpsAlert(
        "Storage billing could not raise some invoices",
        [
          `${failures.length} storage ${failures.length === 1 ? "item" : "items"} failed on ${today}. Released periods retry automatically on the next run; any marked “NOT released” need manual attention.`,
          ...failures,
        ],
        "money",
      );
    }

    // Non-fatal errors (email/PDF trouble, usually) are not money-wrong, but a
    // silent Resend outage must be visible the same day — separate, non-money
    // alert so the accounts desk isn't paged for an email hiccup.
    if (summary.errors.length) {
      await sendOpsAlert(
        "Storage billing non-fatal errors",
        [
          `${summary.errors.length} non-fatal ${summary.errors.length === 1 ? "error" : "errors"} on ${today} (the invoices themselves are fine — usually email/PDF trouble).`,
          ...summary.errors,
        ],
        "system",
      );
    }

    /* ---------------- refresh unpaid statuses ---------------- */
    // statusUpdated counts rows CHANGED. On its own it cannot distinguish "every
    // invoice is still unpaid" from "the ledger was unreachable for all 25", and
    // the latter used to leave nothing behind but a log line. Count the reads.
    let statusUpdated = 0;
    let statusReads = 0;
    let statusReadFailures = 0;
    const { data: unpaid } = await admin
      .from("storage_invoices")
      .select("id, zoho_invoice_id, invoice_provider")
      .eq("status", "sent")
      .not("zoho_invoice_id", "is", null)
      .order("updated_at", { ascending: true })
      .limit(25);
    for (const row of unpaid ?? []) {
      try {
        statusReads++;
        // Route to the ledger that raised this storage invoice, not to the
        // one configured today — storage bills across any cutover (0109).
        const status = await getInvoiceStatus(row.zoho_invoice_id!, asProvider(row.invoice_provider));
        if (status.status === "paid") {
          await admin.from("storage_invoices").update({ status: "paid" } as never).eq("id", row.id);
          statusUpdated++;
        } else if (status.status === "void") {
          await admin.from("storage_invoices").update({ status: "void" } as never).eq("id", row.id);
          statusUpdated++;
        }
      } catch (e) {
        // Transient ledger error — next run retries. Logged AND counted: the log
        // line alone was invisible to the run summary, so a persistent outage
        // reported a healthy run (and cleared this job's operational issue).
        statusReadFailures++;
        log.warn("cron.storage-billing.status_refresh_failed", { invoiceId: row.zoho_invoice_id, ...errorContext(e) });
      }
    }

    /* ---------------- stranded handling events ---------------- */
    // An unbilled event on a let that ended days ago sits outside every future
    // billing window — the final invoice has been and gone, so it will NEVER
    // bill automatically. Flag it until a human invoices it in Zoho manually
    // or deletes the event.
    let strandedCount = 0;
    const strandedCutoff = new Date(`${today}T00:00:00Z`);
    strandedCutoff.setUTCDate(strandedCutoff.getUTCDate() - 3);
    const { data: stranded, error: strandedErr } = await admin
      .from("storage_handling_events")
      .select("let_id, kind, event_date, amount, storage_lets!inner(end_date)")
      .is("billed_invoice_id", null)
      .lt("storage_lets.end_date", strandedCutoff.toISOString().slice(0, 10));
    if (strandedErr) {
      // The stranded check IS the safety net for silent revenue loss — its own
      // failure must be visible, not a server-log whisper.
      log.warn("cron.storage-billing.stranded_check_failed", { error: strandedErr.message });
      await sendOpsAlert(
        "Storage billing: stranded-events check failed",
        [`The stranded handling-events check could not run on ${today} (${strandedErr.message}). Unbilled events on ended lets may be going unflagged — re-run the cron or check manually.`],
        "system",
      );
    } else if (stranded?.length) {
      strandedCount = stranded.length;
      await sendOpsAlert(
        "Storage handling events stranded on ended lets",
        [
          `${stranded.length} unbilled handling ${stranded.length === 1 ? "event sits" : "events sit"} on lets that ended over 3 days ago — these will never bill automatically. Invoice in Zoho manually or delete the event.`,
          ...stranded.map((e) => `Let ${e.let_id.slice(0, 8)} · ${e.kind} ${e.event_date} · £${Number(e.amount).toFixed(2)}`),
        ],
        "money",
      );
    }

    return {
      today,
      adopted: repair.adopted,
      released: repair.released,
      raised: summary.raised,
      emailed: summary.emailed,
      statusUpdated,
      statusReads,
      statusReadFailures,
      // Every read failing means this sweep learned nothing about which storage
      // invoices are paid — a failed run, not a quiet one.
      ...(blindSweepFailure("storage invoice status", statusReads, statusReadFailures) ?? {}),
      stranded: strandedCount,
      resentInvoiceEmails: resend.resent,
      errors: summary.errors,
      billingFailures: summary.billingFailures,
      repairAlerts: repair.alerts,
      resendAlerts: resend.alerts,
    };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
