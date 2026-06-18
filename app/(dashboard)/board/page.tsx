import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBoard } from "@/components/board/status-board";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: leads } = await supabase
    .from("leads")
    .select("id, name, status, entry_channel, from_postcode, to_postcode")
    .order("submitted_at", { ascending: false });

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Board" />
      <StatusBoard leads={leads ?? []} />
    </main>
  );
}
