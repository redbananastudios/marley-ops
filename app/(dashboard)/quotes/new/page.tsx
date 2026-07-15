import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { ukPhone } from "@/lib/phone";
import { createDraftQuote } from "@/app/(dashboard)/quotes/actions";
import { AddLeadForm } from "@/app/(dashboard)/leads/new/add-lead-form";
import type { ClientOption } from "@/components/clients/client-combobox";

/**
 * /quotes/new
 *  - ?leadId=… → the quote already has a customer (created from a lead): make
 *    the draft and bounce straight to the builder (unchanged path).
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
    const res = await createDraftQuote({ leadId });
    if (!res.ok) throw new Error(res.error || "Could not create a new quote");
    redirect(`/quotes/${res.id}`);
  }

  const sb = await createClient();
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
        />
      </Card>
    </main>
  );
}
