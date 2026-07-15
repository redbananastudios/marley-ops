import { describe, expect, it } from "vitest";
import {
  deriveReachedStatus,
  deriveStages,
  funnelIndex,
  isClosed,
  nextChipHref,
  PIPELINE_STAGES,
} from "@/lib/leads/funnel";

describe("funnelIndex / isClosed", () => {
  it("indexes the linear funnel and returns -1 for off-funnel statuses", () => {
    expect(funnelIndex("website_enquiry")).toBe(0);
    expect(funnelIndex("provisional")).toBe(3);
    expect(funnelIndex("completed")).toBe(5);
    expect(funnelIndex("declined")).toBe(-1);
    expect(funnelIndex("nonsense")).toBe(-1);
  });

  it("treats completed and declined as closed", () => {
    expect(isClosed("completed")).toBe(true);
    expect(isClosed("declined")).toBe(true);
    expect(isClosed("quoted")).toBe(false);
    expect(isClosed("website_enquiry")).toBe(false);
  });
});

describe("deriveStages — live statuses", () => {
  it("marks earlier stages done, the matching stage current, and later hollow", () => {
    const stages = deriveStages("quoted");
    expect(stages.map((s) => s.state)).toEqual([
      "done", // enquiry
      "done", // survey
      "current", // quoted
      "upcoming", // deposit
      "upcoming", // confirmed
      "upcoming", // completed
    ]);
    expect(stages).toHaveLength(6);
  });

  it("provisional lights the Deposit stage", () => {
    const stages = deriveStages("provisional");
    const deposit = stages.find((s) => s.key === "deposit")!;
    expect(deposit.state).toBe("current");
    expect(stages.find((s) => s.key === "quoted")!.state).toBe("done");
    expect(stages.find((s) => s.key === "confirmed")!.state).toBe("upcoming");
  });

  it("completed has no upcoming stage (last stage is current)", () => {
    const stages = deriveStages("completed");
    expect(stages.every((s) => s.state !== "upcoming")).toBe(true);
    expect(stages.at(-1)!.state).toBe("current");
  });

  it("an unknown status falls back to the first stage as current", () => {
    const stages = deriveStages("mystery");
    expect(stages[0].state).toBe("current");
  });
});

describe("deriveStages — declined (lost)", () => {
  it("shows only the reached trail plus a terminal Lost chip", () => {
    const stages = deriveStages("declined", { reachedStatus: "quoted" });
    expect(stages.map((s) => s.key)).toEqual(["enquiry", "survey", "quoted", "lost"]);
    expect(stages.slice(0, 3).every((s) => s.state === "done")).toBe(true);
    expect(stages.at(-1)!.state).toBe("lost");
  });

  it("defaults a lost lead with no signal to enquiry + Lost", () => {
    const stages = deriveStages("declined");
    expect(stages.map((s) => s.key)).toEqual(["enquiry", "lost"]);
    expect(stages[0].state).toBe("done");
    expect(stages[1].state).toBe("lost");
  });

  it("carries the trail all the way to confirmed when it got that far", () => {
    const stages = deriveStages("declined", { reachedStatus: "confirmed" });
    expect(stages.map((s) => s.key)).toEqual([
      "enquiry",
      "survey",
      "quoted",
      "deposit",
      "confirmed",
      "lost",
    ]);
  });
});

describe("deriveReachedStatus", () => {
  it("escalates by artefact: accepted+paid → confirmed", () => {
    expect(deriveReachedStatus({ hasAcceptedQuote: true, depositPaid: true })).toBe("confirmed");
  });
  it("accepted but unpaid → provisional (deposit stage)", () => {
    expect(deriveReachedStatus({ hasAcceptedQuote: true })).toBe("provisional");
  });
  it("a sent quote → quoted", () => {
    expect(deriveReachedStatus({ hasSentQuote: true })).toBe("quoted");
  });
  it("only a survey → survey_booked", () => {
    expect(deriveReachedStatus({ hasSurvey: true })).toBe("survey_booked");
  });
  it("nothing → website_enquiry", () => {
    expect(deriveReachedStatus({})).toBe("website_enquiry");
  });
});

describe("nextChipHref", () => {
  it("maps each next stage to its navigation target (never a status write)", () => {
    expect(nextChipHref("survey", "L1")).toBe("/schedule/surveys?leadId=L1");
    expect(nextChipHref("quoted", "L1")).toBe("/quotes/new?leadId=L1");
    expect(nextChipHref("deposit", "L1")).toBe("/bookings");
    expect(nextChipHref("confirmed", "L1")).toBe("/bookings");
    expect(nextChipHref("completed", "L1")).toBe("/schedule/removals?leadId=L1");
  });
  it("has no target for the enquiry origin or unknown keys", () => {
    expect(nextChipHref("enquiry", "L1")).toBeNull();
    expect(nextChipHref("lost", "L1")).toBeNull();
  });
});

describe("PIPELINE_STAGES", () => {
  it("has the six stages 1:1 with the funnel order", () => {
    expect(PIPELINE_STAGES.map((s) => s.status)).toEqual([
      "website_enquiry",
      "survey_booked",
      "quoted",
      "provisional",
      "confirmed",
      "completed",
    ]);
  });
});
