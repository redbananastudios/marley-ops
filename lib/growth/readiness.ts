import type { OpsSnapshot, SnapshotArtifact } from "./types";

/**
 * Pure derivation from the ops snapshot to what the /growth page renders.
 * No fetching here — testable with a plain snapshot object.
 */

export const ARTIFACT_LABELS: Record<string, string> = {
  tracking_validation: "Tracking validation (GA4 + PostHog)",
  landing_tracking_spec: "Landing tracking spec",
  landing_image_plan: "Landing image plan",
  funnel_export: "Funnel export",
  ads_optimization: "Ads optimisation report",
  ads_creative_matrix: "Ads creative matrix",
  chatgpt_ads_brief: "ChatGPT Ads brief",
  analytics_sidecar: "Social analytics side-car",
};

export type ArtifactStatus = "fresh" | "stale" | "missing";

export type ArtifactView = {
  kind: string;
  label: string;
  status: ArtifactStatus;
  requiredForLaunch: boolean;
  ageText: string;
};

export function artifactStatus(a: SnapshotArtifact): ArtifactStatus {
  if (!a.exists || !a.loadable) return "missing";
  return a.is_stale ? "stale" : "fresh";
}

export function ageText(a: SnapshotArtifact): string {
  if (!a.exists) return "never generated";
  if (a.age_days == null) return `max ${a.max_age_days} days`;
  const age = a.age_days < 1 ? "today" : a.age_days < 2 ? "1 day old" : `${Math.round(a.age_days)} days old`;
  return `${age} · max ${a.max_age_days} days`;
}

/** Table rows, launch-critical artifacts first, then required, then the rest. */
export function artifactViews(snapshot: OpsSnapshot): ArtifactView[] {
  const rank = (a: SnapshotArtifact) => (a.required_before_paid_launch ? 0 : a.required ? 1 : 2);
  return Object.values(snapshot.artifacts)
    .sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind))
    .map((a) => ({
      kind: a.kind,
      label: ARTIFACT_LABELS[a.kind] ?? a.kind,
      status: artifactStatus(a),
      requiredForLaunch: a.required_before_paid_launch,
      ageText: ageText(a),
    }));
}

export type NextAction = { title: string; detail: string };

/**
 * Map the snapshot's blocking issues to the concrete human steps that clear
 * them. The tracking_validation mapping is the launch-unblock sequence agreed
 * for Growth Suite v1; unknown blockers fall through verbatim so nothing the
 * agents report can be silently dropped.
 */
export function nextActions(snapshot: OpsSnapshot): NextAction[] {
  const actions: NextAction[] = [];
  const seen = new Set<string>();
  for (const issue of snapshot.blocking_issues) {
    const key = `${issue.code}:${issue.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (issue.kind === "tracking_validation") {
      // A run that produced a verdict means creds already work; only a
      // missing/stale artifact needs the access step.
      if (issue.code === "missing_required_artifact" || issue.code === "tracking_validation_stale") {
        actions.push({
          title: "Confirm PostHog project + GA4 access",
          detail: "PostHog keys and GA4 grants must cover the Marley properties before validation can read events.",
        });
      }
      actions.push(
        {
          title: "Wire the site to fire the spec events",
          detail: `The landing tracking spec (variant ${snapshot.landing_summary.variant_key ?? "—"}) defines the required events and properties — the tracking gaps card below lists exactly what is missing.`,
        },
        {
          title: "Re-run tracking validation on i9",
          detail: "python -m tracking.cli validate --brand " + snapshot.brand + " — a pass flips this page to ready.",
        },
      );
    } else {
      actions.push({ title: issue.message, detail: issue.blocks_paid_launch ? "Blocks paid launch." : "" });
    }
  }
  return actions;
}

/** Days between the snapshot's generated_at and now (fractional). */
export function snapshotAgeDays(snapshot: OpsSnapshot, now: Date = new Date()): number | null {
  const t = Date.parse(snapshot.generated_at);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

/** The snapshot itself goes untrustworthy if i9 stops pushing. */
export const SNAPSHOT_MAX_AGE_DAYS = 3;

export function snapshotIsStale(snapshot: OpsSnapshot, now: Date = new Date()): boolean {
  const age = snapshotAgeDays(snapshot, now);
  return age == null || age > SNAPSHOT_MAX_AGE_DAYS;
}
