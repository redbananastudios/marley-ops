/**
 * Growth Suite artifact shapes. These mirror the JSON the RBS-OS agent suite
 * pushes into public.growth_artifacts (one row per brand + artifact_type).
 * The agents are propose-only: every ads payload carries
 * mutation_allowed:false and nothing here can execute a campaign.
 */

export type GrowthArtifactRow = {
  brand: string;
  artifact_type: string;
  generated_at: string | null;
  pushed_at: string;
  source_host: string | null;
  payload: unknown;
};

/** ops_export snapshot — the launch-readiness read model. */
export type OpsSnapshot = {
  schema_version: string;
  brand: string;
  generated_at: string;
  summary: { artifacts_present: number; artifacts_total: number; present: string[]; stale: string[] };
  artifacts: Record<string, SnapshotArtifact>;
  launch_readiness: { launch_ready: boolean; blockers: string[]; rule: string };
  funnel_summary: {
    available: boolean;
    summary: {
      total_leads: number;
      booked_count: number;
      quoted_count: number;
      lost_count: number;
      lead_to_book_rate: number | null;
      quote_to_book_rate: number | null;
    };
    by_status: Record<string, number>;
    warnings: string[];
    freshness: string;
  };
  tracking_summary: {
    available: boolean;
    status: string | null;
    launch_allowed: boolean;
    validation_id: string | null;
    is_stale: boolean;
    freshness: string;
  };
  landing_summary: {
    tracking_spec_available: boolean;
    image_plan_available: boolean;
    variant_key: string | null;
    landing_page_version: string | null;
  };
  ads_summary: {
    optimization_available: boolean;
    optimizer_live_data_used: boolean;
    optimizer_mutation_allowed: boolean;
    optimizer_human_review_required: boolean;
    recommendations_count: number;
    creative_matrix_available: boolean;
    creative_rows_count: number;
    free_boxes_conditional: boolean;
    free_box_led_ads_blocked: boolean;
    chatgpt_brief_available: boolean;
    chatgpt_status: string | null;
    chatgpt_manual_setup_required: boolean;
  };
  blocking_issues: { code: string; kind: string; blocks_paid_launch: boolean; message: string }[];
  warnings: { code: string; kind: string; message: string }[];
  next_actions: string[];
};

export type SnapshotArtifact = {
  kind: string;
  exists: boolean;
  loadable: boolean;
  required: boolean;
  required_before_paid_launch: boolean;
  generated_at: string | null;
  age_days: number | null;
  freshness: string;
  max_age_days: number;
  is_stale: boolean;
};

/** tracking validation run (GA4 + PostHog, read-only on the agents box). */
export type TrackingValidation = {
  brand: string;
  validation_id: string;
  status: "pending" | "pass" | "fail" | "inconclusive" | string;
  launch_allowed: boolean;
  missing: { ga4: string[]; posthog: string[] };
  property_gaps: { ga4: Record<string, string[]>; posthog: Record<string, string[]> };
  recommendations: string[];
  generated_at: string;
};

/** ads creative testing matrix (channels × angles). */
export type CreativeMatrix = {
  brand: string;
  generated_at: string;
  channels: string[];
  angles: string[];
  mutation_allowed: boolean;
  rows: CreativeRow[];
  warnings: { code: string; message: string }[];
};

export type CreativeRow = {
  row_id: string;
  channel: string;
  angle: string;
  headline_hint: string;
  body_hint: string;
  visual_concept: string;
  cta: string;
  status: string;
};

/** ChatGPT Ads brief (brief-only; manual setup in the ads UI). */
export type ChatgptBrief = {
  brand: string;
  generated_at: string;
  campaign: {
    campaign_name: string;
    objective: string;
    budget_daily: number | null;
    currency: string;
    status: string;
    primary_metric: string;
  };
  ad_groups: {
    name: string;
    purpose: string;
    context_hints: string[];
    avoid: string[];
    landing_page: string;
    status: string;
  }[];
  geo_caveat: string;
  status: string;
  warnings: { code: string; message: string }[];
};

/** Weekly optimisation report (propose-only recommendations). */
export type OptimizeReport = {
  brand: string;
  generated_at: string;
  channel: string;
  live_data_used: boolean;
  data_sources_missing: string[];
  recommendations: Recommendation[];
  warnings: { code: string; message: string }[];
};

export type Recommendation = {
  recommendation_id: string;
  channel: string;
  priority: "high" | "medium" | "low" | string;
  action_type: string;
  recommendation: string;
  evidence: string;
  evidence_type: string;
  confidence: string;
  expected_impact: string;
  risk: string;
  implementation_notes: string;
  status: string;
};
