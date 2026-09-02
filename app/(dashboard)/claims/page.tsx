import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam, BRAND_FILTER_PARAM } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandChip } from "@/components/brand/brand-chip";
import { BrandFilter } from "@/components/brand/brand-filter";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { ClaimStatusPill } from "@/components/claims/claim-status-pill";
import { requireOfficeProfile } from "@/lib/ai/auth";
import {
  CLAIM_CHANNEL_LABEL,
  CLAIM_RESOLUTION_LABEL,
  OPEN_CLAIM_STATUSES,
  claimRef,
  daysOpen,
  isOpenClaimStatus,
  type ClaimChannel,
  type ClaimResolution,
  type ClaimStatus,
} from "@/lib/claims";
import { UK_TZ } from "@/lib/uk-time";

/**
 * /claims — the incident-to-resolution register (stage 2, Peter 2026-07-16).
 * Every damage/service claim: opened automatically from a sign-off exception
 * or by hand from the enquiry, tracked open → assessing → offer → settled/
 * rejected/closed with the resolution + amount. Office-only (liability +
 * money posture — crew never see it).
 */

export const dynamic = "force-dynamic";

const TABS = [
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TZ,
  });

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; brand?: string }>;
}) {
  const office = await requireOfficeProfile();
  if (!office) redirect("/");

  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "open") as "open" | "closed" | "all";

  const sb = await createClient();
  // Brand layer (multi-brand PRD §4 Claims): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1).
  const activeBrands = await listActiveBrandsOrEmpty(sb);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);
  // Open-claim badge is the live-liability signal, so it must be the TRUE total,
  // not "open within the 400 most-recently-reported" — a head count query keeps
  // it independent of the display window (which caps at 400 for render weight).
  const [{ data: rows }, { count: openTotal }] = await Promise.all([
    sb
      .from("claims")
      .select(
        "id, claim_no, lead_id, client_id, status, reported_at, reported_channel, description, resolution, resolution_amount, closed_at",
      )
      .order("reported_at", { ascending: false })
      .limit(400),
    sb
      .from("claims")
      .select("id", { count: "exact", head: true })
      .in("status", [...OPEN_CLAIM_STATUSES]),
  ]);

  const all = rows ?? [];
  const claims = all.filter((c) =>
    tab === "all" ? true : tab === "open" ? isOpenClaimStatus(c.status) : !isOpenClaimStatus(c.status),
  );

  // Claims carry no brand column, so brand rides the existing per-batch leads
  // lookup (the /bookings supplementary-read precedent), narrowed IN THE DB
  // via applyBrandFilter. In multi-brand mode the lookup widens to every
  // window row so the Open tab count can follow the filter too.
  const leadIds = [...new Set((multi ? all : claims).map((c) => c.lead_id))];
  // PostgREST .in() rides the GET query string — past ~200 UUIDs it 414s and
  // the join silently returns nothing, so the lookup goes in batches of 100.
  const leadName = new Map<string, string | null>();
  const leadBrand = new Map<string, string>();
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data: leadRows, error: leadErr } = await applyBrandFilter(
      sb.from("leads").select("id, name, brand").in("id", leadIds.slice(i, i + 100)),
      brandFilter,
    );
    // Fail loud once a brand filter narrows rows: a failed batch would then
    // silently DROP every claim in it (the "I could not check" rule), where
    // unfiltered it only degrades a name to "Customer" as before.
    if (leadErr && brandFilter !== "all")
      throw new Error(`claims brand read failed: ${leadErr.message}`);
    for (const l of leadRows ?? []) {
      leadName.set(l.id, l.name);
      leadBrand.set(l.id, l.brand);
    }
  }

  const visible = brandFilter === "all" ? claims : claims.filter((c) => leadBrand.has(c.lead_id));
  // Filtered, the badge counts open claims of that brand within the display
  // window; unfiltered it keeps the exact head count (the live-liability
  // signal, independent of the 400-row window).
  const openCount =
    brandFilter === "all"
      ? (openTotal ?? all.filter((c) => isOpenClaimStatus(c.status)).length)
      : all.filter((c) => isOpenClaimStatus(c.status) && leadBrand.has(c.lead_id)).length;

  // Chip hidden when the segmented control already names one brand
  // (multi-brand PRD §4 opening rules).
  const showBrandChips = multi && brandFilter === "all";
  const chipBySlug = new Map(activeBrands.map((b) => [b.slug, b]));

  const tabHref = (key: string): string => {
    const qs = new URLSearchParams();
    if (key !== "open") qs.set("tab", key);
    if (brandFilter !== "all") qs.set(BRAND_FILTER_PARAM, brandFilter);
    const s = qs.toString();
    return s ? `/claims?${s}` : "/claims";
  };

  const now = new Date();

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Claims">
        <p className="text-sm text-mist-400">
          Damage and service claims, incident to resolution — sign-off exceptions open one
          automatically.
        </p>
        {/* Brand filter (multi-brand PRD §4 Claims) — this page has no search
            bar, so the segmented control lives in the PageHeader and composes
            with the Open/Closed/All tabs below. */}
        {multi ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={segmentedTrackClass}>
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={tabHref(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={segmentedItemClass(tab === t.key)}
            >
              {t.label}
              {t.key === "open" ? ` (${openCount})` : ""}
            </Link>
          ))}
        </div>
      </div>

      <Card className="p-0">
        {visible.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={tab === "open" ? "No open claims" : "No claims here"}
            hint="Sign-off exceptions open a claim automatically; open one by hand from the enquiry's Claims card."
          />
        ) : (
          <ul className="divide-y">
            {visible.map((c) => {
              const open = isOpenClaimStatus(c.status);
              const amount = c.resolution_amount != null ? Number(c.resolution_amount) : null;
              // Brand chip — after the claim ref, before the status pill
              // (multi-brand PRD §4 Claims).
              const chipBrand = showBrandChips ? chipBySlug.get(leadBrand.get(c.lead_id) ?? "") : undefined;
              return (
                <li key={c.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/claims/${c.id}`}
                      className="focus-ring font-mono text-sm font-semibold text-foreground hover:underline"
                    >
                      {claimRef(c.claim_no)}
                    </Link>
                    {chipBrand ? <BrandChip brand={chipBrand} /> : null}
                    <ClaimStatusPill status={c.status as ClaimStatus} />
                    <span className="text-sm font-medium text-foreground">
                      {leadName.get(c.lead_id) ?? "Customer"}
                    </span>
                    <span className="text-xs text-mist-400">
                      {CLAIM_CHANNEL_LABEL[c.reported_channel as ClaimChannel]} · {fmtAt(c.reported_at)}
                      {open
                        ? ` · ${daysOpen(c.reported_at, now)} day${daysOpen(c.reported_at, now) === 1 ? "" : "s"} open`
                        : c.resolution
                          ? ` · ${CLAIM_RESOLUTION_LABEL[c.resolution as ClaimResolution]}${amount != null && amount > 0 ? ` £${amount.toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : ""}`
                          : ""}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-mist-400">{c.description}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-mist-400">
        <ShieldCheck className="size-3.5" strokeWidth={1.75} />
        Each claim links its evidence — signed certificate, crew notes and photos, the quote&apos;s
        inventory — ready for the insurer.
      </p>
    </main>
  );
}
