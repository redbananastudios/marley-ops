import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { ukPhone } from "@/lib/phone";
import { nextInvoiceDate, type BillableLet } from "@/lib/storage-billing";
import {
  StorageView,
  type LetInvoice,
  type LetRow,
  type PickerClient,
  type SiteRow,
  type UnitRow,
} from "@/components/storage/storage-view";

export const dynamic = "force-dynamic";

export default async function StoragePage() {
  const supabase = await createClient();

  const [{ data: sites }, { data: units }, lets, clients] = await Promise.all([
    supabase.from("storage_sites").select("*").order("is_active", { ascending: false }).order("name"),
    supabase.from("storage_units").select("*").order("is_active", { ascending: false }).order("code").order("name"),
    // Full let history stays small for a long time (1 site today); page it anyway.
    fetchAllRows((f, t) =>
      supabase
        .from("storage_lets")
        .select("id, unit_id, client_id, start_date, end_date, rate, rate_period, notes, billing_paused")
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase
        .from("clients")
        .select("id, display_name, email, phone_e164, phone_raw")
        .is("merged_into_id", null)
        .eq("is_active", true)
        .order("id")
        .range(f, t),
    ),
  ]);

  // Phase 2 context: each let's agreement signature + its raised invoices.
  const letIds = lets.map((l) => l.id);
  const [{ data: agreements }, { data: invoices }] = await Promise.all([
    letIds.length
      ? supabase
          .from("signatures")
          .select("storage_let_id, signer_name, channel")
          .eq("kind", "storage")
          .in("storage_let_id", letIds)
      : Promise.resolve({ data: [] as { storage_let_id: string | null; signer_name: string; channel: string }[] }),
    letIds.length
      ? supabase
          .from("storage_invoices")
          .select("id, let_id, period_start, amount, status, zoho_invoice_number, zoho_invoice_url")
          .in("let_id", letIds)
          .order("period_start", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const agreementByLet = new Map(
    (agreements ?? []).filter((a) => a.storage_let_id).map((a) => [a.storage_let_id as string, a]),
  );
  const invoicesByLet = new Map<string, LetInvoice[]>();
  const invoicedStartsByLet = new Map<string, Set<string>>();
  for (const inv of invoices ?? []) {
    const list = invoicesByLet.get(inv.let_id) ?? [];
    if (list.length < 4) {
      list.push({
        id: inv.id,
        period_start: inv.period_start,
        amount: Number(inv.amount),
        status: inv.status,
        zoho_invoice_number: inv.zoho_invoice_number,
        zoho_invoice_url: inv.zoho_invoice_url,
      });
    }
    invoicesByLet.set(inv.let_id, list);
    const starts = invoicedStartsByLet.get(inv.let_id) ?? new Set<string>();
    starts.add(inv.period_start.slice(0, 10));
    invoicedStartsByLet.set(inv.let_id, starts);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const clientName = new Map(clients.map((c) => [c.id, c.display_name as string]));
  const letRows: LetRow[] = lets.map((l) => {
    const agr = agreementByLet.get(l.id);
    return {
      ...l,
      rate: l.rate == null ? null : Number(l.rate),
      billing_paused: !!l.billing_paused,
      client_name: clientName.get(l.client_id) ?? "Unknown client",
      agreement: agr ? { signer: agr.signer_name, channel: agr.channel } : null,
      next_invoice: nextInvoiceDate(l as BillableLet, invoicedStartsByLet.get(l.id) ?? new Set(), today),
      invoices: invoicesByLet.get(l.id) ?? [],
    };
  });

  const picker: PickerClient[] = clients.map((c) => ({
    id: c.id,
    name: c.display_name ?? "—",
    phone: ukPhone(c.phone_raw ?? c.phone_e164) ?? null,
    email: c.email ?? null,
  }));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Storage" />
      <StorageView
        sites={(sites ?? []) as SiteRow[]}
        units={(units ?? []) as UnitRow[]}
        lets={letRows}
        clients={picker}
      />
    </main>
  );
}
