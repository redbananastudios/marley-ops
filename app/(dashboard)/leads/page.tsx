import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { SyncLeadsButton } from "@/components/sync-leads-button";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { CHANNEL_LABELS } from "@/lib/leads/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { LeadsFilterBar } from "./leads-filter-bar";

export const dynamic = "force-dynamic";

type SearchParams = {
  status?: string;
  channel?: string;
  q?: string;
  tab?: string;
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function postcodeLine(from: string | null, to: string | null): string {
  const f = from?.trim();
  const t = to?.trim();
  if (f && t) return `${f} → ${t}`;
  if (f) return `from ${f}`;
  if (t) return `to ${t}`;
  return "no postcodes";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const status = sp.status?.trim() || "";
  const channel = sp.channel?.trim() || "";
  const q = sp.q?.trim() || "";
  const tab = sp.tab === "web" ? "web" : "all";

  const supabase = await createClient();
  let query = supabase
    .from("leads")
    .select(
      "id, name, phone, email, status, entry_channel, from_postcode, to_postcode, submitted_at",
    )
    .order("submitted_at", { ascending: false });

  if (status) query = query.eq("status", status as never);
  if (tab === "web") {
    query = query.eq("entry_channel", "web");
  } else if (channel) {
    query = query.eq("entry_channel", channel as never);
  }
  if (q) {
    const term = q.replace(/[%,()]/g, " ").trim();
    query = query.or(
      `name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%,from_postcode.ilike.%${term}%,to_postcode.ilike.%${term}%`,
    );
  }

  const { data: leads } = await query;
  const rows = leads ?? [];

  const tabHref = (next: "all" | "web") => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (channel && next !== "web") params.set("channel", channel);
    if (q) params.set("q", q);
    if (next === "web") params.set("tab", "web");
    const qs = params.toString();
    return qs ? `/leads?${qs}` : "/leads";
  };

  const tabs: { key: "all" | "web"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "web", label: "Web-synced" },
  ];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Leads">
        <SyncLeadsButton />
        <Button asChild>
          <Link href="/leads/new">
            <Plus strokeWidth={1.75} />
            Add lead
          </Link>
        </Button>
      </PageHeader>

      <div className="mb-4 inline-flex rounded-md border p-0.5">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <Link
              key={t.key}
              href={tabHref(t.key)}
              className={cn(
                "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-card text-foreground shadow-xs"
                  : "text-mist-400 hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <LeadsFilterBar />

      <Card className="mt-4 p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-mist-400">
            No leads match.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="px-5 text-right">Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const channelLabel =
                  CHANNEL_LABELS[r.entry_channel] ??
                  r.entry_channel.replace(/_/g, " ");
                return (
                  <TableRow key={r.id} className="group">
                    <TableCell className="h-14 px-5">
                      <Link
                        href={`/leads/${r.id}`}
                        className="block min-w-0"
                      >
                        <span className="block truncate font-semibold text-foreground">
                          {r.name ?? "—"}
                        </span>
                        <span className="block truncate text-xs text-mist-400">
                          {channelLabel} ·{" "}
                          {postcodeLine(r.from_postcode, r.to_postcode)}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="h-14">
                      <Link href={`/leads/${r.id}`} className="block">
                        <LeadStatusBadge status={r.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="h-14 px-5 text-right">
                      <Link
                        href={`/leads/${r.id}`}
                        className="block tabular text-sm text-mist-500"
                      >
                        {formatDate(r.submitted_at)}
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </main>
  );
}
