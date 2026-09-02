import { requireAdminPage } from "@/lib/auth";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET } from "@/lib/signatures";
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
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";

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
  searchParams: Promise<{ q?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  // Admin-only: absent from ESTIMATOR_NAV, and hidden nav is not a gate.
  await requireAdminPage();
  const query = (sp.q ?? "").trim();
  // Same sanitize as /quotes — the search is applied in-memory here, but keeping
  // the grammar-safe term means the two pages behave identically for a user.
  const term = query.replace(/[,()%*\\"]/g, "").trim();

  const supabase = await createClient();

  // Brand layer (multi-brand PRD §4 Pipeline and jobs): with a single active
  // brand no brand UI renders and the page is unchanged (the single-brand
  // invariant, PRD §1). The ?brand= filter narrows the base leads query, so
  // the enrichment batches and the count all follow it for free.
  const activeBrands = await listActiveBrandsOrEmpty(supabase);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);

  // Base set: every completed lead (unbounded → page through fetchAllRows).
  const leads = await fetchAllRows<CompletedLead & { brand: string }>((f, t) =>
    applyBrandFilter(
      supabase
        .from("leads")
        .select("id, brand, name, client_id, updated_at, from_postcode, to_postcode, review_requested_at, review_suppressed")
        .eq("status", "completed"),
      brandFilter,
    )
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
    const store = createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET });
    const signed = await Promise.all(
      certPaths.map((path) =>
        store.createSignedGetUrl(path, 3600).then(
          (url) => [path, url] as const,
          () => null, // drop any path whose sign fails, as before
        ),
      ),
    );
    for (const s of signed) if (s) certUrl.set(s[0], s[1]);
  }

  // Brand slug per lead — buildCompletedJobRows is brand-agnostic (shared,
  // pure), so the slug rejoins the shaped rows here for the chip.
  const brandByLead = new Map(leads.map((l) => [l.id, l.brand]));

  const viewRows: CompletedJobRowView[] = rows.map((r) => ({
    ...r,
    certificateUrl: r.certificatePath ? (certUrl.get(r.certificatePath) ?? null) : null,
    brand: brandByLead.get(r.leadId) ?? null,
  }));

  // Minimal serialisable brand shape for the client view — satisfies both
  // BrandChipData and BrandFilterOption; keeps brand config (emails, phone
  // numbers, template ids) out of the client payload. Same pattern as /leads.
  const brandOptions = multi
    ? activeBrands.map((b) => ({
        slug: b.slug,
        name: b.name,
        shortName: b.shortName,
        initial: b.initial,
        colourPrimary: b.colourPrimary,
      }))
    : [];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Completed Jobs" />
      <CompletedJobsView
        rows={viewRows}
        query={query}
        brands={brandOptions}
        showBrandChips={multi && brandFilter === "all"}
      />
    </main>
  );
}
