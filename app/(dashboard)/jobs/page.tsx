import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { PageHeader } from "@/components/page-header";
import {
  buildCompletedJobRows,
  type CompletedCompletion,
  type CompletedLead,
  type CompletedQuote,
  type CompletedRemovalAppt,
} from "@/lib/completed-jobs";
import { CompletedJobsView, type CompletedJobRowView } from "@/components/jobs/completed-jobs-view";

/**
 * /jobs — Completed Jobs (Peter, 2026-07-14). The chronological ledger of
 * finished moves — a completed job is a lead in `completed` status. Enriches
 * each with its move date (latest removal appointment), accepted quote ref +
 * value, completion certificate, review-ask state and any recorded exceptions.
 * Certificates also live in /documents; this is the by-date operational view.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Completed Jobs" };

export default async function CompletedJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  // Same sanitize as /quotes — the search is applied in-memory here, but keeping
  // the grammar-safe term means the two pages behave identically for a user.
  const term = query.replace(/[,()%*\\"]/g, "").trim();

  const supabase = await createClient();

  // Base set: every completed lead (unbounded → page through fetchAllRows).
  const leads = await fetchAllRows<CompletedLead>((f, t) =>
    supabase
      .from("leads")
      .select("id, name, client_id, updated_at, from_postcode, to_postcode, review_requested_at, review_suppressed")
      .eq("status", "completed")
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("id")
      .range(f, t),
  );

  const leadIds = leads.map((l) => l.id);

  // Enrichment — batched by lead id (no N+1). Only fires when there's a base set.
  const [appointments, quotes, completions] = leadIds.length
    ? await Promise.all([
        fetchAllRows<CompletedRemovalAppt>((f, t) =>
          supabase
            .from("appointments")
            .select("lead_id, starts_at")
            .eq("appt_type", "removal")
            .neq("status", "cancelled")
            .in("lead_id", leadIds)
            .range(f, t),
        ),
        fetchAllRows<CompletedQuote>((f, t) =>
          supabase
            .from("quotes")
            .select("lead_id, quote_ref, status, agreed_price, grand_total, accepted_at, created_at")
            .eq("status", "accepted")
            .in("lead_id", leadIds)
            .range(f, t),
        ),
        fetchAllRows<CompletedCompletion>((f, t) =>
          supabase
            .from("job_completions")
            .select("lead_id, exceptions, certificate_path, signed_at")
            .in("lead_id", leadIds)
            .range(f, t),
        ),
      ])
    : [[], [], []];

  const rows = buildCompletedJobRows({ leads, appointments, quotes, completions, search: term });

  // Certificate links are short-lived signed URLs from the private job-docs
  // bucket (service role) — resolved in one batch, exactly as /documents does.
  const certPaths = rows.map((r) => r.certificatePath).filter(Boolean) as string[];
  const certUrl = new Map<string, string>();
  if (certPaths.length) {
    const { data: signedUrls } = await createAdminClient()
      .storage.from("job-docs")
      .createSignedUrls(certPaths, 3600);
    for (const s of signedUrls ?? []) if (s.signedUrl && s.path) certUrl.set(s.path, s.signedUrl);
  }

  const viewRows: CompletedJobRowView[] = rows.map((r) => ({
    ...r,
    certificateUrl: r.certificatePath ? (certUrl.get(r.certificatePath) ?? null) : null,
  }));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Completed Jobs" />
      <CompletedJobsView rows={viewRows} query={query} />
    </main>
  );
}
