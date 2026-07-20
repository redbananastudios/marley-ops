import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log, errorContext } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/comms/send";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { accountsAddress, accountsFrom } from "@/lib/comms/sender";
import {
  createInvoice,
  findInvoiceByReference,
  findOrCreateContact,
  getInvoicePdfBase64,
  getInvoiceStatus,
} from "@/lib/zoho";
import { periodsDue, storageInvoiceReference, type BillableLet } from "@/lib/storage-billing";
import {
  buildStorageInvoiceEmailHtml,
  storageInvoiceSubject,
  type StorageInvoiceEmailInput,
} from "@/lib/comms/storage-invoice-email";
import { UNIT_TYPES } from "@/lib/storage-units";

/**
 * Storage billing (daily Vercel cron, ~08:00 UK). For every priced, unpaused
 * let: raise the Zoho invoice for each period whose start day has arrived,
 * email the customer with the PDF attached, and refresh unpaid invoice
 * statuses so the panel shows paid/outstanding without opening Zoho.
 *
 * Never-create-twice: unique(let_id, period_start) is the DB claim; the Zoho
 * reference (MMS-<let>-<period>) adopts an orphan if we crashed between the
 * Zoho create and the write-back. No pro-rata on release — periods starting
 * after end_date simply never bill (see lib/storage-billing.ts).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UK = "Europe/London";

const gbp = (n: number): string => "£" + n.toFixed(2);

const prettyDay = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  const run = await runCron("storage-billing", async () => {
  const admin = createAdminClient();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const summary = { raised: 0, emailed: 0, statusUpdated: 0, errors: [] as string[], billingFailures: [] as string[] };

  // Lets that can still owe a period: open, or ended within the last 60 days.
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 60);
  const { data: lets } = await admin
    .from("storage_lets")
    .select("id, unit_id, client_id, start_date, end_date, rate, rate_period, billing_paused, notes")
    .gt("rate", 0)
    .or(`end_date.is.null,end_date.gte.${cutoff.toISOString().slice(0, 10)}`);

  const letIds = (lets ?? []).map((l) => l.id);
  const [{ data: invoices }, { data: units }, { data: clients }] = await Promise.all([
    letIds.length
      ? admin.from("storage_invoices").select("let_id, period_start").in("let_id", letIds)
      : Promise.resolve({ data: [] as { let_id: string; period_start: string }[] }),
    admin.from("storage_units").select("id, code, name, unit_type, site_id"),
    letIds.length
      ? admin
          .from("clients")
          .select("id, display_name, email, phone_e164, phone_raw")
          .in("id", [...new Set((lets ?? []).map((l) => l.client_id))])
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const { data: sites } = await admin.from("storage_sites").select("id, name");

  const invoicedByLet = new Map<string, Set<string>>();
  for (const inv of invoices ?? []) {
    const set = invoicedByLet.get(inv.let_id) ?? new Set<string>();
    set.add(inv.period_start.slice(0, 10));
    invoicedByLet.set(inv.let_id, set);
  }
  const unitById = new Map((units ?? []).map((u) => [u.id, u]));
  const siteName = new Map((sites ?? []).map((s) => [s.id, s.name]));
  const clientById = new Map(
    (clients ?? []).map((c: { id: string; display_name: string | null; email: string | null; phone_e164: string | null; phone_raw: string | null }) => [c.id, c]),
  );
  const typeLabel = new Map<string, string>(UNIT_TYPES.map((t) => [t.value, t.label]));

  /* ---------------- raise due invoices ---------------- */
  for (const let_ of lets ?? []) {
    const due = periodsDue(let_ as BillableLet, invoicedByLet.get(let_.id) ?? new Set(), today);
    if (!due.length) continue;
    const unit = unitById.get(let_.unit_id);
    const client = clientById.get(let_.client_id);
    const unitLabel = `${typeLabel.get(unit?.unit_type ?? "") ?? "Storage unit"}${unit?.code ? ` ${unit.code}` : ""}${
      unit?.site_id && siteName.get(unit.site_id) ? ` at ${siteName.get(unit.site_id)}` : ""
    }`;

    for (const period of due) {
      try {
        // DB claim first — a concurrent/repeat run loses the unique insert and skips.
        const { data: claimed, error: claimErr } = await admin
          .from("storage_invoices")
          .insert({
            let_id: let_.id,
            client_id: let_.client_id,
            period_start: period.period_start,
            period_end: period.period_end,
            amount: period.amount,
            status: "pending",
          } as never)
          .select("id")
          .single();
        if (claimErr || !claimed) {
          if (claimErr?.code !== "23505") summary.errors.push(`claim ${let_.id} ${period.period_start}: ${claimErr?.message}`);
          continue;
        }

        const reference = storageInvoiceReference(let_.id, period.period_start);
        const periodLabel = `${prettyDay(period.period_start)} – ${prettyDay(period.period_end)}`;
        let ref = await findInvoiceByReference(reference); // adopt an orphan
        if (!ref) {
          const contactId = await findOrCreateContact({
            name: client?.display_name ?? "Storage customer",
            email: client?.email ?? null,
            phone: client?.phone_e164 ?? client?.phone_raw ?? null,
          });
          ref = await createInvoice({
            customerId: contactId,
            reference,
            description: `Storage — ${unitLabel}, ${periodLabel}`,
            amount: period.amount,
            notes: "Storage is billed in advance per period. Pay by bank transfer using the invoice number as the reference.",
            disableOnlinePayments: true, // card policy: deposit only
          });
        }
        await admin
          .from("storage_invoices")
          .update({
            zoho_invoice_id: ref.invoiceId,
            zoho_invoice_number: ref.invoiceNumber,
            zoho_invoice_url: ref.invoiceUrl,
            status: "sent",
          } as never)
          .eq("id", claimed.id);
        summary.raised++;

        // Email (fail-soft — the invoice stands; Comms shows a failure).
        if (client?.email) {
          const input: StorageInvoiceEmailInput = {
            firstName: (client.display_name ?? "").trim().split(/\s+/)[0] || "there",
            unitLabel,
            periodLabel,
            amountLabel: gbp(period.amount),
            invoiceNumber: ref.invoiceNumber,
            invoiceUrl: ref.invoiceUrl,
          };
          let pdf: string | undefined;
          try {
            pdf = await getInvoicePdfBase64(ref.invoiceId);
          } catch (e) {
            pdf = undefined; // email still sends, just without the VAT PDF
            log.warn("cron.storage-billing.pdf_failed", { invoiceId: ref.invoiceId, ...errorContext(e) });
          }
          const sent = await sendEmail({
            to: client.email,
            subject: storageInvoiceSubject(input),
            html: buildStorageInvoiceEmailHtml(input),
            attachments: pdf ? [{ filename: `${ref.invoiceNumber}.pdf`, content: pdf }] : undefined,
            // Money desk identity — storage bills have no quote token, so
            // replies go straight to the accounts mailbox.
            replyTo: accountsAddress(),
            from: accountsFrom(),
          });
          if (sent.ok) {
            await admin.from("storage_invoices").update({ emailed_at: new Date().toISOString() } as never).eq("id", claimed.id);
            summary.emailed++;
          } else {
            summary.errors.push(`email ${ref.invoiceNumber}: ${sent.error}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        summary.errors.push(`${let_.id} ${period.period_start}: ${msg}`);
        // RELEASE the claim so the period retries next run — do NOT leave a
        // pending/error row behind. periodsDue() is status-agnostic (it reads
        // every storage_invoices row for the let), so a surviving claim would be
        // treated as "already billed" forever → silent under-bill. Deleting the
        // still-pending row is safe: it never carries a zoho_invoice_id (the
        // write-back runs only on success), and orphan adoption via the stable
        // MMS-<let>-<period> reference makes the re-create idempotent even if
        // Zoho did create the invoice before the failure. A row that already
        // reached 'sent' has a real invoice and is untouched by the status gate.
        const { error: delErr } = await admin
          .from("storage_invoices")
          .delete()
          .eq("let_id", let_.id)
          .eq("period_start", period.period_start)
          .eq("status", "pending");
        summary.billingFailures.push(
          `Let ${let_.id.slice(0, 8)} · period ${period.period_start} · ${msg}${
            delErr ? ` · ⚠️ NOT released (${delErr.message}) — may not bill until fixed` : " · released for retry"
          }`,
        );
      }
    }
  }

  // A billing failure that isn't surfaced becomes a permanent under-bill. One
  // consolidated money alert (not one per period) so a full Zoho outage doesn't
  // flood the accounts desk.
  if (summary.billingFailures.length) {
    await sendOpsAlert(
      "Storage billing could not raise some invoices",
      [
        `${summary.billingFailures.length} storage ${summary.billingFailures.length === 1 ? "period" : "periods"} failed to bill on ${today}. Released periods retry automatically on the next run; any marked “NOT released” need manual attention.`,
        ...summary.billingFailures,
      ],
      "money",
    );
  }

  /* ---------------- refresh unpaid statuses ---------------- */
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
        summary.statusUpdated++;
      } else if (status.status === "void") {
        await admin.from("storage_invoices").update({ status: "void" } as never).eq("id", row.id);
        summary.statusUpdated++;
      }
    } catch (e) {
      // transient Zoho error — next run retries; log so a persistent one is visible
      log.warn("cron.storage-billing.status_refresh_failed", { invoiceId: row.zoho_invoice_id, ...errorContext(e) });
    }
  }

  return { today, ...summary };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
