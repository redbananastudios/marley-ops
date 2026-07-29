import Link from "next/link";
import { CheckCircle2, CircleAlert, Megaphone, OctagonX, Square } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { getGrowthArtifact } from "@/lib/growth/data";
import {
  artifactViews,
  nextActions,
  snapshotIsStale,
  SNAPSHOT_MAX_AGE_DAYS,
  type ArtifactStatus,
} from "@/lib/growth/readiness";
import type { OpsSnapshot, TrackingValidation } from "@/lib/growth/types";
import { groupLeadsByVariant } from "@/lib/growth/variants";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { UK_TZ } from "@/lib/uk-time";

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<ArtifactStatus, string> = {
  fresh: "bg-success-bg text-success",
  stale: "bg-warn-bg text-warn",
  missing: "bg-danger-bg text-danger",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: UK_TZ });
}

export default async function GrowthPage() {
  const sb = await createClient();
  const [row, validationRow, variantLeads] = await Promise.all([
    getGrowthArtifact<OpsSnapshot>(sb, "marley_ops_snapshot"),
    getGrowthArtifact<TrackingValidation>(sb, "tracking_validation"),
    fetchAllRows((f, t) => sb.from("leads").select("utm_content, status").order("id").range(f, t)),
  ]);

  if (!row) {
    return (
      <main className="flex-1 p-6 md:p-8">
        <PageHeader eyebrow="Marketing" title="Website & Tracking" />
        <Card className="p-8 text-center">
          <p className="text-sm font-medium text-foreground">No growth snapshot has been pushed yet</p>
          <p className="mt-1 text-sm text-mist-400">
            Run the ops export + push on the agents box, then refresh: <code className="text-xs">python -m ops_export.cli snapshot --brand marley-moves</code> followed by <code className="text-xs">python tools/growth_push_ops.py --brand marley-moves</code>.
          </p>
        </Card>
      </main>
    );
  }

  const snapshot = row.payload;
  const ready = snapshot.launch_readiness.launch_ready;
  const stale = snapshotIsStale(snapshot);
  const views = artifactViews(snapshot);
  const actions = nextActions(snapshot);
  const funnel = snapshot.funnel_summary;
  const tracking = snapshot.tracking_summary;
  const ads = snapshot.ads_summary;
  const adsValidation = snapshot.validation_summary ?? null;
  const validation = validationRow?.payload ?? null;
  const variants = groupLeadsByVariant(variantLeads);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Marketing" title="Website & Tracking">
        <span className="text-xs text-mist-400">
          Snapshot from {row.payload.brand} agents · generated {fmt(snapshot.generated_at)} · pushed {fmt(row.pushedAt)}
        </span>
      </PageHeader>

      {/* verdict */}
      <div
        className={
          "mb-4 flex items-center gap-3 rounded-lg border px-5 py-4 " +
          (ready ? "border-success-border bg-success-bg" : "border-danger-border bg-danger-bg")
        }
      >
        {ready ? (
          <CheckCircle2 className="size-6 shrink-0 text-success" strokeWidth={1.75} />
        ) : (
          <OctagonX className="size-6 shrink-0 text-danger" strokeWidth={1.75} />
        )}
        <div>
          <p className={"text-[15px] font-semibold " + (ready ? "text-success" : "text-danger")}>
            Paid launch: {ready ? "ready" : "blocked"}
          </p>
          <p className={"text-sm " + (ready ? "text-success" : "text-danger")}>
            {ready
              ? "Tracking validation passed and every launch-required artifact is fresh."
              : snapshot.launch_readiness.blockers[0] ?? "Blocked by the agents' launch gate."}
            {" "}Ads remain proposal-only either way — nothing spends without a human.
          </p>
        </div>
      </div>

      {stale ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warn-border bg-warn-bg px-4 py-3">
          <CircleAlert className="size-4 shrink-0 text-warn" strokeWidth={1.75} />
          <p className="text-sm text-warn">
            This snapshot is over {SNAPSHOT_MAX_AGE_DAYS} days old — re-run the push on the agents box before trusting it.
          </p>
        </div>
      ) : null}

      {/* summary cards */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-mist-400">Tracking validation</p>
          <p className={"mt-1 text-lg font-semibold " + (tracking.status === "pass" ? "text-success" : "text-danger")}>
            {tracking.available ? tracking.status ?? "unknown" : "Missing"}
          </p>
          <p className="mt-1 text-xs text-mist-400">GA4 + PostHog · {tracking.freshness}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-mist-400">Ads validation</p>
          <p className={"mt-1 text-lg font-semibold " + (adsValidation?.ads_validation_status === "pass" ? "text-success" : "text-danger")}>
            {adsValidation?.ads_validation_available ? adsValidation.ads_validation_status ?? "unknown" : "Missing"}
          </p>
          <p className="mt-1 text-xs text-mist-400">
            {adsValidation?.ads_validation_available
              ? `${adsValidation.ads_validation_blocks ?? 0} blocks · judge ${adsValidation.ads_validation_judge_passed === true ? "pass" : adsValidation.ads_validation_judge_passed === false ? "fail" : "pending"} · ${adsValidation.ads_validation_freshness}`
              : "rules + LLM judge · run the ads validator"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-mist-400">Funnel (agent-side)</p>
          <p className="mt-1 text-lg font-semibold text-foreground">
            {funnel.available ? `${funnel.summary.total_leads} leads` : "No export"}
          </p>
          <p className="mt-1 text-xs text-mist-400">
            {funnel.available
              ? `${funnel.summary.quoted_count} quoted · ${funnel.summary.booked_count} booked`
              : "run funnel export"}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-mist-400">Ad proposals</p>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {ads.creative_rows_count} creatives · {ads.recommendations_count} recs
              </p>
              <p className="mt-1 text-xs text-mist-400">proposal-only · human review required</p>
            </div>
            <Link
              href="/growth/ads"
              className="focus-ring inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Megaphone className="size-3.5" strokeWidth={1.75} />
              Review
            </Link>
          </div>
        </Card>
      </div>

      {/* what unblocks launch */}
      {actions.length > 0 ? (
        <Card className="mb-6 p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">What unblocks launch</h2>
          </div>
          <ul className="divide-y">
            {actions.map((a) => (
              <li key={a.title} className="flex items-start gap-3 px-5 py-3">
                <Square className="mt-0.5 size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                <div>
                  <p className="text-sm font-medium text-foreground">{a.title}</p>
                  {a.detail ? <p className="text-xs text-mist-400">{a.detail}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* tracking gaps — what the site must fire, straight from the validator */}
      {validation && validation.status !== "pass" ? (
        <Card className="mb-6 p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Tracking gaps</h2>
            <span className="text-xs text-mist-400">
              validation {validation.validation_id} · {fmt(validation.generated_at)}
            </span>
          </div>
          <div className="grid gap-0 sm:grid-cols-2">
            {(["ga4", "posthog"] as const).map((platform) => (
              <div key={platform} className="border-b px-5 py-4 sm:odd:border-r">
                <p className="text-xs font-semibold uppercase tracking-wide text-mist-500">
                  {platform === "ga4" ? "GA4" : "PostHog"}
                </p>
                {validation.missing[platform].length > 0 ? (
                  <>
                    <p className="mt-2 text-xs text-mist-400">Missing critical events</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {validation.missing[platform].map((ev) => (
                        <span key={ev} className="rounded-pill bg-danger-bg px-2 py-0.5 font-mono text-[11px] text-danger">
                          {ev}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-success">All critical events observed</p>
                )}
                {Object.keys(validation.property_gaps[platform]).length > 0 ? (
                  <>
                    <p className="mt-3 text-xs text-mist-400">Events firing without variant_key</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.keys(validation.property_gaps[platform]).map((ev) => (
                        <span key={ev} className="rounded-pill bg-warn-bg px-2 py-0.5 font-mono text-[11px] text-warn">
                          {ev}
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
          <p className="px-5 py-3 text-xs text-mist-400">
            Red = the event was never observed on that platform. Amber = it fires but without the variant_key property,
            so it cannot be attributed to a landing variant.
          </p>
        </Card>
      ) : null}

      {/* leads by landing variant (Ops-side, joined on utm_content) */}
      <Card className="mb-6 p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Leads by landing variant</h2>
          <span className="text-xs text-mist-400">
            utm_content carries the agents&apos; variant key
            {variants.untagged > 0 ? ` · ${variants.untagged} leads without a variant tag` : ""}
          </span>
        </div>
        {variants.rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">
            No variant-tagged leads yet — they appear here once paid traffic lands on a tagged landing page.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Variant</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Leads</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Won</th>
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Win rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {variants.rows.map((v) => (
                  <tr key={v.variant}>
                    <td className="px-5 py-3 font-mono text-xs text-foreground">{v.variant}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{v.total}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{v.won}</td>
                    <td className="tabular px-5 py-3 text-right font-semibold text-foreground">{v.winRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* artifact freshness */}
      <Card className="mb-6 p-0">
        <div className="border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Artifacts feeding this page</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="eyebrow px-5 py-3 font-semibold">Artifact</th>
                <th className="eyebrow px-2 py-3 font-semibold">Status</th>
                <th className="eyebrow px-2 py-3 font-semibold">Age</th>
                <th className="eyebrow px-5 py-3 text-right font-semibold">Launch</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {views.map((v) => (
                <tr key={v.kind}>
                  <td className="px-5 py-3 font-medium text-foreground">{v.label}</td>
                  <td className="px-2 py-3">
                    <span
                      className={
                        "rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide " + STATUS_PILL[v.status]
                      }
                    >
                      {v.status}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-mist-500">{v.ageText}</td>
                  <td className="px-5 py-3 text-right text-xs text-mist-400">
                    {v.requiredForLaunch ? "required for launch" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* warnings from the agents */}
      {snapshot.warnings.length > 0 ? (
        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Warnings</h2>
          </div>
          <ul className="divide-y">
            {snapshot.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="flex items-start gap-3 px-5 py-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.75} />
                <p className="text-sm text-foreground">{w.message}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </main>
  );
}
