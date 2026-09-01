import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { listActiveBrands } from "@/lib/brand";
import { ukPhone } from "@/lib/phone";
import { AddLeadForm, type AddLeadBrandOption } from "@/app/(dashboard)/leads/new/add-lead-form";
import { CreateDraftAndOpen } from "@/app/(dashboard)/quotes/new/create-draft-and-open";
import type { ClientOption } from "@/components/clients/client-combobox";

/**
 * /quotes/new
 *  - ?leadId=… → the quote already has a customer (created from a lead): hand
 *    off to CreateDraftAndOpen, which makes the draft with ONE client-side
 *    server-action call and navigates to the builder. The render itself stays
 *    read-only: Next can invoke it twice for one client-side navigation, and
 *    writing + redirecting here intermittently crashed the soft navigation
 *    to the error boundary (QA-20260827-03 / QA-20260828-02).
 *  - no leadId → the "New quote" button: capture the customer + move details
 *    first (Peter, 2026-07-11 — every quote belongs to a client→lead, no orphan
 *    quotes), create the lead + draft quote in one step, then open the builder
 *    pre-filled. Nothing to re-enter later.
 *
 * Next 16: searchParams is async.
 */
export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; clientId?: string }>;
}) {
  // ?clientId=… pre-selects that customer in the form (the client page's
  // "New quote" action) — a repeat customer shouldn't be re-typed.
  const { leadId, clientId } = await searchParams;

  if (leadId) {
    return (
      <main className="flex-1 p-6 md:p-8">
        <CreateDraftAndOpen leadId={leadId} />
      </main>
    );
  }

  const sb = await createClient();
  // GATE 5: the reused AddLeadForm carries the same required brand selector
  // as /leads/new when no ?leadId= is present (PRD §4 /quotes/new). Empty in
  // single-brand mode — the invariant keeps this page byte-identical.
  const activeBrands = await listActiveBrands(sb);
  const brandOptions: AddLeadBrandOption[] =
    activeBrands.length > 1
      ? activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))
      : [];
  const { data: clients } = await sb
    .from("clients")
    .select("id, display_name, email, phone_e164, phone_raw, postcode_home")
    .is("merged_into_id", null)
    .eq("is_active", true)
    .order("display_name", { ascending: true });

  const clientOptions: ClientOption[] = (clients ?? []).map((c) => ({
    id: c.id,
    display_name: c.display_name,
    email: c.email,
    phone: ukPhone(c.phone_raw ?? c.phone_e164),
    postcode: c.postcode_home,
  }));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader
        eyebrow="Sales"
        title="New quote"
        backHref="/quotes"
        backLabel="Quotes"
      />
      <p className="mb-5 max-w-2xl text-sm text-mist-500">
        Pick an existing customer or add a new one, and capture the move details — we&apos;ll create the record and
        drop you straight into the quote builder with everything filled in.
      </p>
      <Card className="max-w-2xl p-6 md:p-8">
        <AddLeadForm
          clients={clientOptions}
          mode="quote"
          initialClientId={clientId && clientOptions.some((c) => c.id === clientId) ? clientId : undefined}
          brands={brandOptions}
        />
      </Card>
    </main>
  );
}
