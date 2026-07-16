import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { ClaimStatusPill } from "@/components/claims/claim-status-pill";
import { requireOfficeProfile } from "@/lib/ai/auth";
import {
  CLAIM_CHANNEL_LABEL,
  CLAIM_RESOLUTION_LABEL,
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
  searchParams: Promise<{ tab?: string }>;
}) {
  const office = await requireOfficeProfile();
  if (!office) redirect("/");

  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "open") as "open" | "closed" | "all";

  const sb = await createClient();
  const { data: rows } = await sb
    .from("claims")
    .select(
      "id, claim_no, lead_id, client_id, status, reported_at, reported_channel, description, resolution, resolution_amount, closed_at",
    )
    .order("reported_at", { ascending: false })
    .limit(400);

  const all = rows ?? [];
  const claims = all.filter((c) =>
    tab === "all" ? true : tab === "open" ? isOpenClaimStatus(c.status) : !isOpenClaimStatus(c.status),
  );
  const openCount = all.filter((c) => isOpenClaimStatus(c.status)).length;

  const leadIds = [...new Set(claims.map((c) => c.lead_id))];
  const { data: leadRows } = leadIds.length
    ? await sb.from("leads").select("id, name").in("id", leadIds)
    : { data: [] as { id: string; name: string | null }[] };
  const leadName = new Map((leadRows ?? []).map((l) => [l.id, l.name]));

  const now = new Date();

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Claims">
        <p className="text-sm text-mist-400">
          Damage and service claims, incident to resolution — sign-off exceptions open one
          automatically.
        </p>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={segmentedTrackClass}>
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.key === "open" ? "/claims" : `/claims?tab=${t.key}`}
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
        {claims.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={tab === "open" ? "No open claims" : "No claims here"}
            hint="Sign-off exceptions open a claim automatically; open one by hand from the enquiry's Claims card."
          />
        ) : (
          <ul className="divide-y">
            {claims.map((c) => {
              const open = isOpenClaimStatus(c.status);
              const amount = c.resolution_amount != null ? Number(c.resolution_amount) : null;
              return (
                <li key={c.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/claims/${c.id}`}
                      className="focus-ring font-mono text-sm font-semibold text-foreground hover:underline"
                    >
                      {claimRef(c.claim_no)}
                    </Link>
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
