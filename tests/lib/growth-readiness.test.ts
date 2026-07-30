import { describe, expect, it } from "vitest";
import {
  ageText,
  artifactStatus,
  artifactViews,
  nextActions,
  snapshotAgeDays,
  snapshotIsStale,
} from "@/lib/growth/readiness";
import type { OpsSnapshot, SnapshotArtifact } from "@/lib/growth/types";

const art = (over: Partial<SnapshotArtifact>): SnapshotArtifact => ({
  kind: "funnel_export",
  exists: true,
  loadable: true,
  required: true,
  required_before_paid_launch: false,
  generated_at: "2026-07-13T10:00:00+00:00",
  age_days: 0,
  freshness: "current",
  max_age_days: 1,
  is_stale: false,
  ...over,
});

const snapshot = (over: Partial<OpsSnapshot> = {}): OpsSnapshot => ({
  schema_version: "1.0",
  brand: "marley-moves",
  generated_at: "2026-07-13T10:00:00+00:00",
  summary: { artifacts_present: 1, artifacts_total: 2, present: ["funnel_export"], stale: [] },
  artifacts: {
    funnel_export: art({}),
    tracking_validation: art({
      kind: "tracking_validation",
      exists: false,
      loadable: false,
      required_before_paid_launch: true,
      generated_at: null,
      age_days: null,
      freshness: "not available",
      max_age_days: 7,
    }),
  },
  launch_readiness: { launch_ready: false, blockers: ["tracking validation missing"], rule: "" },
  funnel_summary: {
    available: true,
    summary: {
      total_leads: 0,
      booked_count: 0,
      quoted_count: 0,
      lost_count: 0,
      lead_to_book_rate: null,
      quote_to_book_rate: null,
    },
    by_status: {},
    warnings: [],
    freshness: "current",
  },
  tracking_summary: {
    available: false,
    status: null,
    launch_allowed: false,
    validation_id: null,
    is_stale: false,
    freshness: "not available",
  },
  landing_summary: {
    tracking_spec_available: true,
    image_plan_available: true,
    variant_key: "lead-form-hero-red",
    landing_page_version: "v1.0",
  },
  ads_summary: {
    optimization_available: true,
    optimizer_live_data_used: false,
    optimizer_mutation_allowed: false,
    optimizer_human_review_required: true,
    recommendations_count: 18,
    creative_matrix_available: true,
    creative_rows_count: 33,
    free_boxes_conditional: true,
    free_box_led_ads_blocked: true,
    chatgpt_brief_available: true,
    chatgpt_status: "manual_setup_required",
    chatgpt_manual_setup_required: true,
  },
  blocking_issues: [
    {
      code: "missing_required_artifact",
      kind: "tracking_validation",
      blocks_paid_launch: true,
      message: "required artifact tracking_validation is missing (blocks paid launch)",
    },
  ],
  warnings: [],
  next_actions: ["Generate the missing tracking_validation artifact."],
  ...over,
});

describe("artifactStatus", () => {
  it("maps missing / stale / fresh", () => {
    expect(artifactStatus(art({ exists: false, loadable: false }))).toBe("missing");
    expect(artifactStatus(art({ is_stale: true }))).toBe("stale");
    expect(artifactStatus(art({}))).toBe("fresh");
  });

  it("treats present-but-unloadable as missing", () => {
    expect(artifactStatus(art({ exists: true, loadable: false }))).toBe("missing");
  });
});

describe("ageText", () => {
  it("says never generated for absent artifacts", () => {
    expect(ageText(art({ exists: false }))).toBe("never generated");
  });

  it("rounds ages sensibly", () => {
    expect(ageText(art({ age_days: 0.2 }))).toBe("today · max 1 days");
    expect(ageText(art({ age_days: 1.4 }))).toBe("1 day old · max 1 days");
    expect(ageText(art({ age_days: 16.2, max_age_days: 14 }))).toBe("16 days old · max 14 days");
  });
});

describe("artifactViews", () => {
  it("puts launch-critical artifacts first and labels them", () => {
    const views = artifactViews(snapshot());
    expect(views[0].kind).toBe("tracking_validation");
    expect(views[0].requiredForLaunch).toBe(true);
    expect(views[0].status).toBe("missing");
    expect(views[0].label).toContain("Tracking validation");
    expect(views[1].kind).toBe("funnel_export");
  });

  it("falls back to the raw kind for unknown artifacts", () => {
    const s = snapshot();
    s.artifacts.mystery_kind = art({ kind: "mystery_kind", required: false });
    const views = artifactViews(s);
    expect(views.find((v) => v.kind === "mystery_kind")?.label).toBe("mystery_kind");
  });
});

describe("nextActions", () => {
  it("expands the tracking_validation blocker into the unblock sequence", () => {
    const actions = nextActions(snapshot());
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toContain("PostHog");
    expect(actions[1].detail).toContain("lead-form-hero-red");
    // No engineer command / machine name leaks into the office-facing steps.
    expect(actions.map((a) => `${a.title} ${a.detail}`).join(" ")).not.toMatch(/i9|tracking\.cli|python/);
  });

  it("drops the creds step once a validation run produced a verdict", () => {
    const s = snapshot({
      blocking_issues: [
        {
          code: "tracking_not_passing",
          kind: "tracking_validation",
          blocks_paid_launch: true,
          message: "tracking validation status is fail; paid launch is blocked",
        },
      ],
    });
    const actions = nextActions(s);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toContain("Waiting on the last tracking signal");
    expect(actions[0].detail).not.toMatch(/i9|tracking\.cli|python/);
  });

  it("passes unknown blockers through verbatim", () => {
    const s = snapshot({
      blocking_issues: [
        { code: "tracking_validation_stale", kind: "weird_new_thing", blocks_paid_launch: true, message: "something new" },
      ],
    });
    const actions = nextActions(s);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe("something new");
    expect(actions[0].detail).toBe("Blocks paid launch.");
  });

  it("dedupes repeated issues of the same code + kind", () => {
    const issue = {
      code: "missing_required_artifact",
      kind: "tracking_validation",
      blocks_paid_launch: true,
      message: "m",
    };
    const actions = nextActions(snapshot({ blocking_issues: [issue, issue] }));
    expect(actions).toHaveLength(2);
  });
});

describe("snapshot staleness", () => {
  const now = new Date("2026-07-15T10:00:00Z");

  it("computes fractional age in days", () => {
    expect(snapshotAgeDays(snapshot(), now)).toBeCloseTo(2, 1);
  });

  it("is fresh within 3 days, stale after", () => {
    expect(snapshotIsStale(snapshot(), now)).toBe(false);
    expect(snapshotIsStale(snapshot(), new Date("2026-07-17T10:00:01Z"))).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(snapshotIsStale(snapshot({ generated_at: "not-a-date" }), now)).toBe(true);
  });
});
