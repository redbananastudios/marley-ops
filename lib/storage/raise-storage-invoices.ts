import type { SupabaseClient } from "@supabase/supabase-js";
import { log, errorContext } from "@/lib/log";
import { sendEmail } from "@/lib/comms/send";
import { accountsAddress, accountsFrom } from "@/lib/comms/sender";
import {
  createInvoice,
  findInvoiceByReference,
  findOrCreateContact,
  getInvoicePdfBase64,
} from "@/lib/zoho";
import {
  invoicesDue,
  storageInvoiceReference,
  type BillableLet,
  type DueInvoice,
  type HandlingEventLite,
} from "@/lib/storage-billing";
import {
  buildStorageInvoiceEmailHtml,
  storageInvoiceSubject,
  type StorageInvoiceEmailInput,
} from "@/lib/comms/storage-invoice-email";
import { UNIT_TYPES } from "@/lib/storage-units";

/**
 * SERVER ONLY — the shared "raise due storage invoices" core. The daily cron
 * runs it across every billable let; the release flow runs it for ONE let the
 * moment end_date lands, so the final invoice exists before goods leave
 * ("all charges settled before release" — docs/storage-billing-v2-prd.md §5).
 *
 * Money invariants carried over from the 0027 cron verbatim:
 *  - DB claim first (unique(let_id, period_start)); 23505 = another run won.
 *  - Zoho reference MMS-<let8>-<period> adopts an orphan after a crash.
 *  - On failure the still-pending claim is DELETED so the period retries —
 *    a surviving claim would read as "already billed" forever (under-bill).
 *  - Handling events are marked billed only AFTER the invoice write-back; a
 *    mark failure is surfaced as a billing failure (double-charge risk) and
 *    never silently swallowed.
 */

const gbp = (n: number): string => "£" + n.toFixed(2);

const prettyDay = (isoDay: string): string =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const EVENT_KIND_LABEL: Record<string, string> = { in: "in", out: "out", access: "access" };

function handlingSuffix(events: HandlingEventLite[]): string {
  if (!events.length) return "";
  const parts = events.map(
    (e) => `${EVENT_KIND_LABEL[e.kind] ?? e.kind} ${prettyDay(e.event_date)} ${gbp(Number(e.amount) || 0)}`,
  );
  return `; handling: ${parts.join(", ")}`;
}

/** Customer-facing line description per invoice kind. */
export function invoiceDescription(due: DueInvoice, unitLabel: string, dayRate: number): string {
  const span = `${prettyDay(due.period_start)} – ${prettyDay(due.period_end)}`;
  switch (due.kind) {
    case "minimum":
      return `Storage — ${unitLabel}, ${due.days}-day minimum (${span})${handlingSuffix(due.handlingEvents)}`;
    case "arrears":
    case "final": {
      if (due.days === 0) return `Storage — ${unitLabel}${handlingSuffix(due.handlingEvents)}`;
      return `Storage — ${unitLabel}, ${due.days} day${due.days === 1 ? "" : "s"} (${span}) @ ${gbp(dayRate)}/day${handlingSuffix(due.handlingEvents)}`;
    }
    default:
      return `Storage — ${unitLabel}, ${span}`;
  }
}

const NOTES: Record<DueInvoice["kind"], string> = {
  period:
    "Storage is billed in advance per period. Pay by bank transfer using the invoice number as the reference.",
  minimum:
    "Your minimum storage period, billed in advance; further days are charged to the exact day in arrears. Pay by bank transfer using the invoice number as the reference.",
  arrears:
    "Storage days billed in arrears to the exact day. Pay by bank transfer using the invoice number as the reference.",
  final:
    "Final storage invoice — all charges are settled before items are released. Pay by bank transfer using the invoice number as the reference.",
};

const FOOTER_NOTES: Partial<Record<DueInvoice["kind"], string>> = {
  minimum:
    "This covers your minimum storage period, billed in advance. After that, storage is charged to the exact day in arrears — reply to this email or call 01747 637070 any time to arrange release.",
  arrears:
    "Storage days are charged to the exact day, in arrears, every 4 weeks. Release is by appointment with all charges settled before your items leave — reply to this email or call 01747 637070 to arrange it.",
  final:
    "This is your final storage invoice — everything is settled before your items are released. Reply to this email or call 01747 637070 with any questions.",
};

function periodLabelFor(due: DueInvoice): string {
  if (due.kind === "final" && due.days === 0) return "handling on release";
  const span = `${prettyDay(due.period_start)} – ${prettyDay(due.period_end)}`;
  if (due.kind === "minimum") return `${due.days}-day minimum, ${span}`;
  if (due.kind === "arrears" || due.kind === "final")
    return `${due.days} day${due.days === 1 ? "" : "s"}, ${span}`;
  return span;
}

export interface RaiseSummary {
  raised: number;
  emailed: number;
  errors: string[];
  billingFailures: string[];
  invoices: { letId: string; invoiceNumber: string; amount: number; kind: string }[];
}

export async function raiseDueStorageInvoices(
  admin: SupabaseClient,
  opts: { todayIso: string; letId?: string },
): Promise<RaiseSummary> {
  const today = opts.todayIso.slice(0, 10);
  const summary: RaiseSummary = { raised: 0, emailed: 0, errors: [], billingFailures: [], invoices: [] };

  // Lets that can still owe a period: open, or ended within the last 60 days.
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 60);
  let letsQuery = admin
    .from("storage_lets")
    .select(
      "id, unit_id, client_id, start_date, end_date, rate, rate_period, billing_paused, billing_model, min_days, min_amount, notes",
    )
    .gt("rate", 0);
  letsQuery = opts.letId
    ? letsQuery.eq("id", opts.letId)
    : letsQuery.or(`end_date.is.null,end_date.gte.${cutoff.toISOString().slice(0, 10)}`);
  const { data: lets } = await letsQuery;

  const letIds = (lets ?? []).map((l) => l.id);
  if (!letIds.length) return summary;

  const [{ data: invoices }, { data: units }, { data: clients }, { data: unbilledEvents }] = await Promise.all([
    admin.from("storage_invoices").select("let_id, period_start").in("let_id", letIds),
    admin.from("storage_units").select("id, code, name, unit_type, site_id"),
    admin
      .from("clients")
      .select("id, display_name, email, phone_e164, phone_raw")
      .in("id", [...new Set((lets ?? []).map((l) => l.client_id))]),
    admin
      .from("storage_handling_events")
      .select("id, let_id, event_date, kind, amount")
      .is("billed_invoice_id", null)
      .in("let_id", letIds),
  ]);
  const { data: sites } = await admin.from("storage_sites").select("id, name");

  const invoicedByLet = new Map<string, Set<string>>();
  for (const inv of invoices ?? []) {
    const set = invoicedByLet.get(inv.let_id) ?? new Set<string>();
    set.add(inv.period_start.slice(0, 10));
    invoicedByLet.set(inv.let_id, set);
  }
  const eventsByLet = new Map<string, HandlingEventLite[]>();
  for (const e of unbilledEvents ?? []) {
    const list = eventsByLet.get(e.let_id) ?? [];
    list.push({ id: e.id, event_date: e.event_date, kind: e.kind, amount: Number(e.amount) || 0 });
    eventsByLet.set(e.let_id, list);
  }
  const unitById = new Map((units ?? []).map((u) => [u.id, u]));
  const siteName = new Map((sites ?? []).map((s) => [s.id, s.name]));
  const clientById = new Map(
    (clients ?? []).map(
      (c: { id: string; display_name: string | null; email: string | null; phone_e164: string | null; phone_raw: string | null }) => [
        c.id,
        c,
      ],
    ),
  );
  const typeLabel = new Map<string, string>(UNIT_TYPES.map((t) => [t.value, t.label]));

  for (const let_ of lets ?? []) {
    const due = invoicesDue(let_ as BillableLet, invoicedByLet.get(let_.id) ?? new Set(), eventsByLet.get(let_.id) ?? [], today);
    if (!due.length) continue;
    const unit = unitById.get(let_.unit_id);
    const client = clientById.get(let_.client_id);
    const unitLabel = `${typeLabel.get(unit?.unit_type ?? "") ?? "Storage unit"}${unit?.code ? ` ${unit.code}` : ""}${
      unit?.site_id && siteName.get(unit.site_id) ? ` at ${siteName.get(unit.site_id)}` : ""
    }`;

    for (const inv of due) {
      try {
        // DB claim first — a concurrent/repeat run loses the unique insert and skips.
        const { data: claimed, error: claimErr } = await admin
          .from("storage_invoices")
          .insert({
            let_id: let_.id,
            client_id: let_.client_id,
            period_start: inv.period_start,
            period_end: inv.period_end,
            amount: inv.amount,
            kind: inv.kind,
            handling_amount: inv.handlingAmount,
            status: "pending",
          } as never)
          .select("id")
          .single();
        if (claimErr || !claimed) {
          if (claimErr?.code !== "23505") summary.errors.push(`claim ${let_.id} ${inv.period_start}: ${claimErr?.message}`);
          continue;
        }

        const reference = storageInvoiceReference(let_.id, inv.period_start);
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
            description: invoiceDescription(inv, unitLabel, Number(let_.rate ?? 0)),
            amount: inv.amount,
            notes: NOTES[inv.kind],
            disableOnlinePayments: true, // card policy: deposit only
            itemName: "Storage", // income separation (accountant maps by item)
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
        summary.invoices.push({ letId: let_.id, invoiceNumber: ref.invoiceNumber, amount: inv.amount, kind: inv.kind });

        // Mark swept handling events billed. A failure here is a DOUBLE-CHARGE
        // risk (unbilled events would ride the next invoice too) — surface it.
        if (inv.handlingEvents.length) {
          const { error: markErr } = await admin
            .from("storage_handling_events")
            .update({ billed_invoice_id: claimed.id } as never)
            .in("id", inv.handlingEvents.map((e) => e.id));
          if (markErr) {
            summary.billingFailures.push(
              `Let ${let_.id.slice(0, 8)} · invoice ${ref.invoiceNumber} raised but handling events could NOT be marked billed (${markErr.message}) — fix manually or they will bill again`,
            );
          }
        }

        // Email (fail-soft — the invoice stands; Comms shows a failure).
        if (client?.email) {
          const input: StorageInvoiceEmailInput = {
            firstName: (client.display_name ?? "").trim().split(/\s+/)[0] || "there",
            unitLabel,
            periodLabel: periodLabelFor(inv),
            amountLabel: gbp(inv.amount),
            invoiceNumber: ref.invoiceNumber,
            invoiceUrl: ref.invoiceUrl,
            footerNote: FOOTER_NOTES[inv.kind],
          };
          let pdf: string | undefined;
          try {
            pdf = await getInvoicePdfBase64(ref.invoiceId);
          } catch (e) {
            pdf = undefined; // email still sends, just without the VAT PDF
            log.warn("storage-billing.pdf_failed", { invoiceId: ref.invoiceId, ...errorContext(e) });
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
        summary.errors.push(`${let_.id} ${inv.period_start}: ${msg}`);
        // RELEASE the claim so the period retries next run — do NOT leave a
        // pending/error row behind. invoicesDue() is status-agnostic (it reads
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
          .eq("period_start", inv.period_start)
          .eq("status", "pending");
        summary.billingFailures.push(
          `Let ${let_.id.slice(0, 8)} · period ${inv.period_start} · ${msg}${
            delErr ? ` · ⚠️ NOT released (${delErr.message}) — may not bill until fixed` : " · released for retry"
          }`,
        );
      }
    }
  }
  return summary;
}
