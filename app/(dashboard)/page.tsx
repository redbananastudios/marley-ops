import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { LeadStatusBadge } from "@/components/lead-status-badge";

export const dynamic = "force-dynamic";

const KPIS: { label: string; statuses: string[] }[] = [
  { label: "New enquiries", statuses: ["website_enquiry"] },
  { label: "Surveys booked", statuses: ["survey_booked"] },
  { label: "Quoted", statuses: ["quoted"] },
  { label: "Confirmed", statuses: ["provisional", "confirmed"] },
];

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: leads } = await supabase
    .from("leads")
    .select("id, name, status, entry_channel, submitted_at")
    .order("submitted_at", { ascending: false });
  const rows = leads ?? [];
  const countOf = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;

  return (
    <main className="flex-1 p-6 md:p-8">
      <header className="mb-6">
        <p className="eyebrow">Pipeline</p>
        <h1 className="font-display text-3xl text-foreground">Dashboard</h1>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {KPIS.map((k) => (
          <Card key={k.label} className="p-5">
            <p className="eyebrow">{k.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular tracking-tight text-foreground">{countOf(k.statuses)}</p>
          </Card>
        ))}
      </div>

      <Card className="p-0">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="font-display text-lg text-foreground">Recent leads</h2>
          <Link href="/leads" className="text-sm text-mm-red hover:underline">
            View all
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">No leads yet.</p>
        ) : (
          <ul className="divide-y">
            {rows.slice(0, 6).map((r) => (
              <li key={r.id}>
                <Link
                  href={`/leads/${r.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-muted"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{r.name ?? "—"}</p>
                    <p className="text-xs text-mist-400">{r.entry_channel.replace(/_/g, " ")}</p>
                  </div>
                  <LeadStatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
