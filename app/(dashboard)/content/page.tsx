import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listActiveBrands } from "@/lib/brand";
import { parseBrandParam, BRAND_FILTER_PARAM } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandFilter } from "@/components/brand/brand-filter";
import { Card } from "@/components/ui/card";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { loadJobMedia } from "@/lib/content/job-media-load";
import { JobMediaList } from "@/components/content/job-media-list";

/**
 * /content — the review queue for captured job content (PRD v1.0 §5).
 * Crew/estimators capture on jobs; everything lands here newest-first; the
 * office approves items before ANY marketing use (Peter's gate). Admin-client
 * data (signed URLs) → explicit office gate, same posture as /finance.
 */

export const dynamic = "force-dynamic";

const TABS = [
  { key: "needs-review", label: "Needs review" },
  { key: "approved", label: "Approved" },
  { key: "internal", label: "Internal only" },
  { key: "all", label: "All" },
] as const;

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; brand?: string }>;
}) {
  const office = await requireOfficeProfile();
  if (!office) redirect("/");

  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "needs-review") as
    | "needs-review"
    | "approved"
    | "internal"
    | "all";

  // Brand layer (multi-brand PRD §4 Content — captured media feeds marketing,
  // which is brand-specific): with a single active brand no brand UI renders
  // and the page is unchanged (the single-brand invariant, PRD §1).
  const sb = await createClient();
  const activeBrands = await listActiveBrands(sb);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);

  // A named ?brand= narrows IN the loader's own query (a leads!inner join +
  // leads.brand filter — see lib/content/job-media-load.ts), so the newest-120
  // window is computed WITHIN the brand. Filtering after the load showed only
  // that brand's slice of the newest 120 rows overall — a brand with older
  // content looked empty while its media sat just past the window. The loader
  // fails LOUD when narrowed (a swallowed error would render "no content" for
  // the brand — the "I could not check" rule); at "all" (and single-brand) the
  // param is omitted and the loader runs byte-identically to before.
  const items = await loadJobMedia({
    filter: tab === "all" ? undefined : tab,
    limit: 120,
    brand: brandFilter !== "all" ? brandFilter : undefined,
  });

  // Chip hidden when the segmented control already names one brand
  // (multi-brand PRD §4 opening rules). Slim 5-field shape for the client
  // list — never the full brand rows.
  const showBrandChips = multi && brandFilter === "all";

  // Brand chips need id→brand for the rendered rows (loadJobMedia is shared,
  // so the chip lookup stays page-side). Chips ONLY — row membership never
  // rides this read (a named ?brand= was narrowed in the loader, and this read
  // runs only on "all") — so it fails SOFT: losing a chip is a lost
  // convenience, losing the review queue is a lost queue (the received-tab
  // chips precedent). CHUNKED at 100 ids: PostgREST .in() rides the GET query
  // string and 414s past ~200 UUIDs (lib/bank-feed/sync.ts measured the limit).
  const brandByLead = new Map<string, string>();
  if (showBrandChips && items.length) {
    const leadIds = [...new Set(items.map((m) => m.leadId))];
    for (let i = 0; i < leadIds.length; i += 100) {
      const { data: leadRows } = await sb
        .from("leads")
        .select("id, brand")
        .in("id", leadIds.slice(i, i + 100));
      for (const l of leadRows ?? []) brandByLead.set(l.id, l.brand);
    }
  }
  const brandOptions = showBrandChips
    ? activeBrands.map((b) => ({
        slug: b.slug,
        name: b.name,
        shortName: b.shortName,
        initial: b.initial,
        colourPrimary: b.colourPrimary,
      }))
    : [];

  const tabHref = (key: string): string => {
    const qs = new URLSearchParams();
    if (key !== "needs-review") qs.set("tab", key);
    if (brandFilter !== "all") qs.set(BRAND_FILTER_PARAM, brandFilter);
    const s = qs.toString();
    return s ? `/content?${s}` : "/content";
  };

  return (
    <main className="flex-1 space-y-4 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Content">
        <p className="text-sm text-mist-400">
          Photos, video and voice notes captured on jobs. Approve the good ones — only approved
          content is ever used for marketing.
        </p>
        {/* Brand filter (multi-brand PRD §4 Content) — segmented control in
            the PageHeader, composing with the four review tabs below. */}
        {multi ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
      </PageHeader>

      <div className={segmentedTrackClass}>
        {TABS.map((t) => (
          <Link key={t.key} href={tabHref(t.key)} className={segmentedItemClass(tab === t.key)}>
            {t.label}
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <JobMediaList
          items={items}
          showJobLink
          brands={brandOptions}
          brandByLead={showBrandChips ? Object.fromEntries(brandByLead) : undefined}
        />
      </Card>
    </main>
  );
}
