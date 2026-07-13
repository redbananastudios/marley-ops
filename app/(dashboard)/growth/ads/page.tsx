import { CircleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { getGrowthArtifact } from "@/lib/growth/data";
import type { ChatgptBrief, CreativeMatrix, OptimizeReport, Recommendation } from "@/lib/growth/types";

export const dynamic = "force-dynamic";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_PILL: Record<string, string> = {
  high: "bg-danger-bg text-danger",
  medium: "bg-warn-bg text-warn",
  low: "bg-mist-100 text-mist-500",
};

function EvidenceBadge({ type }: { type: string }) {
  return (
    <span className="rounded-pill bg-mist-100 px-2 py-0.5 text-[11px] font-medium text-mist-500">
      {type.replaceAll("_", " ")}
    </span>
  );
}

export default async function GrowthAdsPage() {
  const sb = await createClient();
  const [matrix, brief, optimize] = await Promise.all([
    getGrowthArtifact<CreativeMatrix>(sb, "ads_creative_matrix"),
    getGrowthArtifact<ChatgptBrief>(sb, "chatgpt_ads_brief"),
    getGrowthArtifact<OptimizeReport>(sb, "ads_optimization"),
  ]);

  if (!matrix && !brief && !optimize) {
    return (
      <main className="flex-1 p-6 md:p-8">
        <PageHeader eyebrow="Growth" title="Ad proposals" backHref="/growth" backLabel="Launch readiness" />
        <Card className="p-8 text-center">
          <p className="text-sm font-medium text-foreground">No ad proposals have been pushed yet</p>
          <p className="mt-1 text-sm text-mist-400">
            Generate them on the agents box (<code className="text-xs">python -m ads.cli matrix / chatgpt-brief / optimize</code>), then push.
          </p>
        </Card>
      </main>
    );
  }

  const recs = [...(optimize?.payload.recommendations ?? [])].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
  );
  const channels = matrix ? [...new Set(matrix.payload.rows.map((r) => r.channel))] : [];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Growth" title="Ad proposals" backHref="/growth" backLabel="Launch readiness" />

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-warn-border bg-warn-bg px-4 py-3">
        <CircleAlert className="size-4 shrink-0 text-warn" strokeWidth={1.75} />
        <p className="text-sm text-warn">
          Everything on this page is a proposal. The agents cannot spend, publish or change any ad platform — campaign
          setup is manual and needs your sign-off.
        </p>
      </div>

      {/* ChatGPT Ads campaign brief */}
      {brief ? (
        <Card className="mb-6 p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">ChatGPT Ads brief</h2>
            <span className="rounded-pill bg-warn-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warn">
              manual setup required
            </span>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-foreground">{brief.payload.campaign.campaign_name}</p>
            <p className="mt-1 text-xs text-mist-400">
              Objective: {brief.payload.campaign.objective} · primary metric: {brief.payload.campaign.primary_metric}
              {brief.payload.campaign.budget_daily != null
                ? ` · £${brief.payload.campaign.budget_daily}/day proposed`
                : " · budget: set at review"}
            </p>
            <p className="mt-2 text-xs text-mist-400">{brief.payload.geo_caveat}</p>
          </div>
          <div className="grid gap-0 border-t sm:grid-cols-2">
            {brief.payload.ad_groups.map((g) => (
              <div key={g.name} className="border-b px-5 py-4 sm:odd:border-r">
                <p className="text-sm font-semibold text-foreground">{g.name}</p>
                <p className="mt-1 text-xs text-mist-500">{g.purpose}</p>
                <p className="mt-2 text-xs text-mist-400">
                  <span className="font-medium text-foreground">Target:</span> {g.context_hints.slice(0, 6).join(", ")}
                </p>
                <p className="mt-1 text-xs text-mist-400">
                  <span className="font-medium text-foreground">Avoid:</span> {g.avoid.slice(0, 5).join(", ")}
                </p>
                <p className="mt-1 text-xs text-mist-400">
                  <span className="font-medium text-foreground">Lands on:</span> {g.landing_page}
                </p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* creative matrix */}
      {matrix ? (
        <Card className="mb-6 p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Creative testing matrix</h2>
            <span className="text-xs text-mist-400">
              {matrix.payload.rows.length} proposed creatives across {channels.join(" · ")}
            </span>
          </div>
          {matrix.payload.warnings.length > 0 ? (
            <div className="border-b px-5 py-3">
              {matrix.payload.warnings.map((w) => (
                <p key={w.code} className="text-xs text-warn">
                  {w.message}
                </p>
              ))}
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Channel</th>
                  <th className="eyebrow px-2 py-3 font-semibold">Angle</th>
                  <th className="eyebrow px-2 py-3 font-semibold">Headline hint</th>
                  <th className="eyebrow px-5 py-3 font-semibold">Visual concept</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {matrix.payload.rows.map((r) => (
                  <tr key={r.row_id}>
                    <td className="px-5 py-3 text-xs font-medium uppercase tracking-wide text-mist-500">{r.channel}</td>
                    <td className="px-2 py-3 text-xs text-foreground">{r.angle.replaceAll("_", " ")}</td>
                    <td className="px-2 py-3 text-foreground">
                      <p className="font-medium">{r.headline_hint}</p>
                      <p className="text-xs text-mist-400">
                        {r.body_hint} · CTA: {r.cta}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-xs text-mist-500">{r.visual_concept}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* optimizer recommendations */}
      {optimize ? (
        <Card className="p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Recommendations</h2>
            <span className="text-xs text-mist-400">
              {optimize.payload.live_data_used
                ? "based on live account data"
                : "rule-based and research-based — no live account data yet"}
            </span>
          </div>
          <ul className="divide-y">
            {recs.map((r: Recommendation) => (
              <li key={r.recommendation_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide " +
                      (PRIORITY_PILL[r.priority] ?? PRIORITY_PILL.low)
                    }
                  >
                    {r.priority}
                  </span>
                  <span className="text-xs uppercase tracking-wide text-mist-400">{r.channel}</span>
                  <EvidenceBadge type={r.evidence_type} />
                </div>
                <p className="mt-2 text-sm font-medium text-foreground">{r.recommendation}</p>
                <p className="mt-1 text-xs text-mist-500">{r.evidence}</p>
                <p className="mt-1 text-xs text-mist-400">
                  Expected impact: {r.expected_impact} · risk: {r.risk} · confidence: {r.confidence}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </main>
  );
}
