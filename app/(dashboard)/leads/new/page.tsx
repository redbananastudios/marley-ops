import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { listActiveBrands } from "@/lib/brand";
import { ukPhone } from "@/lib/phone";
import { AddLeadForm, type AddLeadBrandOption } from "./add-lead-form";
import type { ClientOption } from "@/components/clients/client-combobox";

export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
  const sb = await createClient();
  // GATE 5: the form's required brand picker exists only in multi-brand mode
  // (the single-brand invariant, PRD §1 — parity CI asserts this exact page).
  // An empty array keeps the form byte-identical to today. Deliberately the
  // THROWING reader, not listActiveBrandsOrEmpty: a failed brands read must
  // yield an error page, never a picker-less form inviting a mis-filed brand.
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
      <PageHeader eyebrow="Pipeline" title="Add lead" />
      <Card className="max-w-2xl p-6 md:p-8">
        <AddLeadForm clients={clientOptions} brands={brandOptions} />
      </Card>
    </main>
  );
}
