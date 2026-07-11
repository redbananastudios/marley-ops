import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogueItem } from "@/lib/cubic-catalogue";

const fixtureSchema = z.object({
  source: z.object({
    clipId: z.string(),
    durationMs: z.number().int().positive(),
    sha256Prefix: z.literal("redacted"),
  }),
  checks: z.object({
    schemaHonoured: z.literal(true),
    timestampsSane: z.literal(true),
    visualEvidenceDetected: z.literal(true),
    audioEvidenceDetected: z.literal(true),
  }).passthrough(),
  result: z.object({
    audio: z.object({
      summaryRedacted: z.boolean(),
    }).passthrough(),
    detections: z.array(z.object({
      evidence: z.literal("[redacted]"),
      catalogueCandidates: z.array(z.object({
        key: z.string(),
        confidence: z.number().min(0).max(1),
      })),
    }).passthrough()),
  }).passthrough(),
}).passthrough();

describe("AI survey Phase 0 fixtures", () => {
  const fixtureDir = resolve(process.cwd(), "tests", "fixtures", "ai-survey-spike");
  const files = readdirSync(fixtureDir).filter((file) => file.endsWith(".json")).sort();

  it("contains four redacted, catalogue-valid model responses", () => {
    expect(files).toHaveLength(4);

    for (const file of files) {
      const raw = readFileSync(resolve(fixtureDir, file), "utf8");
      expect(raw).not.toContain("observedLabel");
      expect(raw).not.toContain("audio.summary");
      expect(raw).not.toContain('"sha256":');

      const fixture = fixtureSchema.parse(JSON.parse(raw));
      for (const detection of fixture.result.detections) {
        for (const candidate of detection.catalogueCandidates) {
          expect(catalogueItem(candidate.key), `${file}: ${candidate.key}`).toBeDefined();
        }
      }
    }
  });
});
