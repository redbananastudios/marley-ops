import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jobCardLook } from "@/lib/my-jobs/job-card";

/**
 * Regression guard for QA-20260820-06: a completed removal stayed on the crew's
 * /my-jobs list looking exactly like an open job — same red MOVE pill, same
 * card, no cue that the crew had already signed it off. The page's query
 * selected `appointments.status` but the Job mapping dropped it, so the card
 * had nothing to render a completed state from.
 */

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("jobCardLook", () => {
  it.each(["removal", "pack", "survey"] as const)(
    "a completed %s is visually distinct from a pending one",
    (type) => {
      const pending = jobCardLook(type, "scheduled");
      const done = jobCardLook(type, "completed");
      expect(done.completed).toBe(true);
      expect(pending.completed).toBe(false);
      expect(done.pill.label).not.toBe(pending.pill.label);
      expect(done.pill.cls).not.toBe(pending.pill.cls);
      expect(done.accent).not.toBe(pending.accent);
    },
  );

  it("a completed job reads Done in success colours", () => {
    const done = jobCardLook("removal", "completed");
    expect(done.pill).toEqual({ label: "Done", cls: "bg-success-bg text-success" });
    expect(done.accent).toContain("border-l-success");
  });

  it("pending pills keep their pre-fix appearance", () => {
    expect(jobCardLook("removal", "scheduled").pill).toEqual({ label: "Move", cls: "bg-mm-red text-white" });
    expect(jobCardLook("pack", "scheduled").pill).toEqual({ label: "Packing", cls: "bg-warn-bg text-warn" });
    expect(jobCardLook("survey", "scheduled").pill).toEqual({ label: "Survey", cls: "bg-muted text-mist-500" });
  });

  it("the subtitle still names the visit type even when the pill says Done", () => {
    expect(jobCardLook("removal", "completed").typeLabel).toBe("Move");
    expect(jobCardLook("pack", "completed").typeLabel).toBe("Packing");
    expect(jobCardLook("survey", "completed").typeLabel).toBe("Survey");
  });

  it("a null/unknown status renders as pending, never as done", () => {
    expect(jobCardLook("removal", null).completed).toBe(false);
    expect(jobCardLook("removal", undefined).completed).toBe(false);
    expect(jobCardLook("removal", "scheduled").pill.label).toBe("Move");
  });
});

describe("/my-jobs carries status through to the card", () => {
  // The original bug lived in what the mapping did NOT carry: the query already
  // selected `status`, but the Job object dropped it, so no render branch was
  // even possible. Type-checking cannot see that — a source contract can.
  it("the Job mapping keeps appointments.status", () => {
    const src = read("app/my-jobs/page.tsx");
    const start = src.indexOf('.from("appointments")');
    expect(start, "/my-jobs no longer queries appointments — update this contract").toBeGreaterThan(-1);
    const query = src.slice(src.indexOf(".select(", start), src.indexOf(".select(", start) + 300);
    expect(query, "the appointments select must include status").toMatch(/\bstatus\b/);
    expect(src, "the Job mapping must carry status to the card render").toMatch(/status:\s*a\.status/);
  });

  it("the card render keys its look off jobCardLook", () => {
    const src = read("app/my-jobs/page.tsx");
    expect(src).toMatch(/jobCardLook\(\s*j\.appt_type,\s*j\.status\s*\)/);
  });
});
