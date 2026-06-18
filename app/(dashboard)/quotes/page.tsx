import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
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

export const dynamic = "force-dynamic";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

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

const STATUS_PILL: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-mist-100 text-charcoal" },
  sent: { label: "Sent", className: "bg-mm-red-tint text-mm-red-deep" },
  accepted: { label: "Accepted", className: "bg-success-bg text-success" },
  rejected: { label: "Rejected", className: "bg-mist-50 text-mist-400" },
  superseded: { label: "Superseded", className: "bg-mist-50 text-mist-400" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_PILL[status] ?? {
    label: status,
    className: "bg-mist-100 text-charcoal",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

type QuoteRow = {
  id: string;
  quote_ref: string | null;
  customer_name: string | null;
  grand_total: number | null;
  status: string;
  email_send_count: number | null;
  created_at: string | null;
};

export default async function QuotesPage() {
  const supabase = await createClient();
  const { data: quotes } = await supabase
    .from("quotes")
    .select(
      "id, quote_ref, customer_name, grand_total, status, email_send_count, created_at",
    )
    .order("created_at", { ascending: false });

  const rows = (quotes ?? []) as QuoteRow[];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Sales" title="Quotes">
        <Button asChild>
          <Link href="/quotes/new">
            <Plus strokeWidth={1.75} />
            New quote
          </Link>
        </Button>
      </PageHeader>

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-mist-400">
            No quotes yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">Ref</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="px-5 text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const href = `/quotes/${r.id}`;
                const sent =
                  r.email_send_count && r.email_send_count > 0
                    ? `×${r.email_send_count}`
                    : "—";
                return (
                  <TableRow key={r.id} className="group">
                    <TableCell className="h-14 px-5">
                      <Link
                        href={href}
                        className="block truncate font-semibold text-foreground"
                      >
                        {r.quote_ref ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="h-14">
                      <Link href={href} className="block truncate text-sm">
                        {r.customer_name ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="h-14 text-right">
                      <Link
                        href={href}
                        className="block tabular text-sm text-foreground"
                      >
                        {gbp(r.grand_total)}
                      </Link>
                    </TableCell>
                    <TableCell className="h-14">
                      <Link href={href} className="block">
                        <StatusPill status={r.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="h-14 text-right">
                      <Link
                        href={href}
                        className="block tabular text-sm text-mist-500"
                      >
                        {sent}
                      </Link>
                    </TableCell>
                    <TableCell className="h-14 px-5 text-right">
                      <Link
                        href={href}
                        className="block tabular text-sm text-mist-500"
                      >
                        {formatDate(r.created_at)}
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
