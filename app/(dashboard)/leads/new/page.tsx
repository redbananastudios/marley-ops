import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { AddLeadForm } from "./add-lead-form";
import type { ClientOption } from "@/components/clients/client-combobox";

export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
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
    phone: c.phone_e164 ?? c.phone_raw,
    postcode: c.postcode_home,
  }));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Add lead" />
      <Card className="max-w-2xl p-6 md:p-8">
        <AddLeadForm clients={clientOptions} />
      </Card>
    </main>
  );
}
