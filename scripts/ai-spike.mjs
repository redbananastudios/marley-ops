#!/usr/bin/env node

/**
 * Phase 0 only: validate Gemini video + audio structured extraction against
 * two private estimator iPad clips before any AI Survey product code is built.
 *
 * Raw clips and full model responses stay under .private/ (git-ignored).
 * Only redacted, catalogue-key-based fixtures are written to tests/fixtures.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { z } from "zod";
import { CUBIC_CATEGORIES } from "../lib/cubic-catalogue.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PRIVATE_DIR = join(ROOT, ".private", "ai-survey-spike");
const PRIVATE_RESULTS_DIR = join(PRIVATE_DIR, "results");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "ai-survey-spike");
const FILES_API = "https://generativelanguage.googleapis.com";
const MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash"];
const PROMPT_VERSION = "spike-v1";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mpeg", ".mpg"]);
const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
};
const PRICING_USD_PER_MILLION = {
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
};

const candidateSchema = z.object({
  key: z.string().min(1).max(120),
  confidence: z.number().min(0).max(1),
});

const videoDetectionSchema = z.object({
  roomType: z.enum([
    "living-room",
    "dining-room",
    "bedroom",
    "kitchen",
    "utility-room",
    "office",
    "garage",
    "garden",
    "loft",
    "hallway",
    "other",
  ]),
  roomConfidence: z.number().min(0).max(1),
  audio: z.object({
    narrationHeard: z.boolean(),
    movingInstructionsHeard: z.boolean(),
    summary: z.string().max(500),
  }),
  coverage: z.object({
    level: z.enum(["complete", "partial", "poor"]),
    issues: z.array(z.enum([
      "too-fast",
      "too-dark",
      "blurred",
      "occluded",
      "storage-not-opened",
      "room-not-fully-shown",
      "no-audible-narration",
      "none",
    ])).max(8),
  }),
  detections: z.array(z.object({
    observedLabel: z.string().min(1).max(120),
    quantity: z.number().int().min(1).max(99),
    moving: z.enum(["moving", "staying", "uncertain"]),
    fragile: z.boolean(),
    dismantle: z.boolean(),
    timestampMs: z.number().int().min(0),
    evidenceSources: z.array(z.enum(["visual", "audio"])).min(1).max(2),
    evidence: z.string().min(1).max(300),
    catalogueCandidates: z.array(candidateSchema).max(3),
  })).max(150),
});

const catalogueItems = CUBIC_CATEGORIES.flatMap((category) =>
  category.items.map((item) => ({
    key: item.key,
    title: item.title,
  })),
);
const catalogueByKey = new Map(catalogueItems.map((item) => [item.key, item]));
const catalogueBlock = catalogueItems.map((item) => `${item.key} | ${item.title}`).join("\n");

function printHelp() {
  console.log(`Marley AI Survey Phase 0 spike

Usage:
  npm run ai:spike -- <clip-1> <clip-2>
  npm run ai:spike

With no paths, the script discovers exactly two video files in:
  ${PRIVATE_DIR}

Requirements:
  - GEMINI_API_KEY in .env.local or the process environment
  - ffprobe on PATH (used only to validate timestamps)
  - two real estimator iPad clips; at least one must be 30-90 seconds
  - an approved small/low-inventory room may be 10-29 seconds

Privacy:
  Raw videos and full responses remain in .private/. Uploaded Gemini Files are
  explicitly deleted after processing. Only redacted fixtures are commit-safe.`);
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, clipPaths: [] };
  }
  const unsupported = args.filter((arg) => arg.startsWith("-"));
  if (unsupported.length > 0) {
    throw new Error(`Unknown option: ${unsupported[0]}`);
  }
  return { help: false, clipPaths: args };
}

async function discoverClips(providedPaths) {
  const paths = providedPaths.length > 0
    ? providedPaths.map((path) => resolve(path))
    : (await readdir(PRIVATE_DIR, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => join(PRIVATE_DIR, entry.name))
      .sort();

  if (paths.length !== 2) {
    throw new Error(
      `Phase 0 requires exactly two clips; found ${paths.length}. ` +
      `Place them in ${PRIVATE_DIR} or pass both paths explicitly.`,
    );
  }

  for (const path of paths) {
    if (!VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new Error(`Unsupported video extension: ${extname(path) || "(none)"}`);
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`Clip is missing or empty: ${basename(path)}`);
    }
  }
  return paths;
}

function readDurationMs(path) {
  try {
    const seconds = Number(execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
      { encoding: "utf8", windowsHide: true },
    ).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid duration");
    return Math.round(seconds * 1000);
  } catch {
    throw new Error("Could not read clip duration with ffprobe. Confirm ffprobe is installed and the clip is valid.");
  }
}

async function apiRequest(pathOrUrl, apiKey, init, operation) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${FILES_API}${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "x-goog-api-key": apiKey,
      ...init.headers,
    },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`${operation} failed (${response.status}): ${detail}`);
  }
  return response;
}

async function uploadGeminiFile(path, clipId, apiKey) {
  const fileInfo = await stat(path);
  const mimeType = MIME_TYPES[extname(path).toLowerCase()];
  const startResponse = await apiRequest(
    "/upload/v1beta/files",
    apiKey,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileInfo.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({ file: { display_name: `marley-ai-spike-${clipId}` } }),
    },
    "Gemini upload start",
  );
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload start returned no resumable upload URL.");

  const finalizeResponse = await apiRequest(
    uploadUrl,
    apiKey,
    {
      method: "POST",
      headers: {
        "Content-Length": String(fileInfo.size),
        "Content-Type": mimeType,
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: createReadStream(path),
      duplex: "half",
    },
    "Gemini upload",
  );
  const payload = await finalizeResponse.json();
  if (!payload.file?.name || !payload.file?.uri) {
    throw new Error("Gemini upload returned an incomplete File resource.");
  }
  try {
    return await waitForActiveFile(payload.file, apiKey);
  } catch (error) {
    await deleteGeminiFile(payload.file.name, apiKey);
    throw error;
  }
}

async function waitForActiveFile(file, apiKey) {
  let current = file;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (current.state !== "ACTIVE") {
    if (current.state === "FAILED") throw new Error("Gemini could not process the uploaded video.");
    if (Date.now() >= deadline) throw new Error("Gemini File processing did not become ACTIVE within 10 minutes.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    const response = await apiRequest(`/v1beta/${current.name}`, apiKey, { method: "GET", headers: {} }, "Gemini file status");
    current = await response.json();
  }
  return current;
}

async function deleteGeminiFile(fileName, apiKey) {
  if (!fileName) return;
  try {
    await apiRequest(`/v1beta/${fileName}`, apiKey, { method: "DELETE", headers: {} }, "Gemini file deletion");
    console.log("  Provider file deleted.");
  } catch (error) {
    console.error(`  WARNING: explicit provider deletion failed: ${error.message}`);
    console.error("  Gemini Files expire automatically, but verify the provider file manually.");
  }
}

function buildPrompt(durationMs) {
  return `You are analysing a removal survey video recorded by a professional estimator.
Use both the visible video and audible narration. Return each distinct movable household item once.
Fitted fixtures (radiators, fitted kitchens, carpets and built-in cupboards) are not inventory.
Narration is authoritative for moving/staying, hidden contents, quantities, fragile and dismantling instructions.
Candidate keys MUST come only from the catalogue below. Return at most three candidates, best first.
Never estimate or return cubic volume. Use millisecond timestamps within 0-${durationMs}.
If no catalogue item is plausible, return an empty candidate list.
Report capture quality honestly and mark coverage partial/poor where appropriate.
For each item, evidenceSources must name only the sources that genuinely support that detection.

MARLEY CATALOGUE (${catalogueItems.length} items):
${catalogueBlock}`;
}

function validateAndNormalise(output, durationMs) {
  const parsed = videoDetectionSchema.parse(output);
  let invalidCandidateCount = 0;
  let outOfRangeTimestampCount = 0;

  const detections = parsed.detections.map((detection) => {
    const catalogueCandidates = detection.catalogueCandidates.filter((candidate) => {
      const valid = catalogueByKey.has(candidate.key);
      if (!valid) invalidCandidateCount += 1;
      return valid;
    });
    const timestampSane = detection.timestampMs <= durationMs + 1_000;
    if (!timestampSane) outOfRangeTimestampCount += 1;
    return { ...detection, timestampSane, catalogueCandidates };
  });

  const matchedCount = detections.filter((item) => item.catalogueCandidates.length > 0).length;
  const visualEvidenceDetected = detections.some((item) => item.evidenceSources.includes("visual"));
  const audioEvidenceDetected = parsed.audio.narrationHeard &&
    detections.some((item) => item.evidenceSources.includes("audio"));
  const catalogueMatchRate = detections.length === 0 ? 0 : matchedCount / detections.length;
  return {
    output: { ...parsed, detections },
    checks: {
      schemaHonoured: true,
      detectionCount: detections.length,
      matchedCount,
      catalogueMatchRate,
      invalidCandidateCount,
      outOfRangeTimestampCount,
      timestampsSane: outOfRangeTimestampCount === 0,
      visualEvidenceDetected,
      audioEvidenceDetected,
      humanCatalogueReviewRequired: true,
    },
  };
}

function calculateCost(model, usage) {
  const pricing = PRICING_USD_PER_MILLION[model];
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000,
  };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function redactedFixture({ clipId, model, durationMs, elapsedMs, usage, normalised }) {
  return {
    fixtureVersion: 1,
    promptVersion: PROMPT_VERSION,
    source: { clipId, durationMs, sha256Prefix: "redacted" },
    model,
    elapsedMs,
    usage,
    checks: normalised.checks,
    result: {
      roomType: normalised.output.roomType,
      roomConfidence: normalised.output.roomConfidence,
      audio: {
        narrationHeard: normalised.output.audio.narrationHeard,
        movingInstructionsHeard: normalised.output.audio.movingInstructionsHeard,
        summaryRedacted: normalised.output.audio.summary.length > 0,
      },
      coverage: normalised.output.coverage,
      detections: normalised.output.detections.map((detection) => ({
        quantity: detection.quantity,
        moving: detection.moving,
        fragile: detection.fragile,
        dismantle: detection.dismantle,
        timestampMs: detection.timestampMs,
        timestampSane: detection.timestampSane,
        evidenceSources: detection.evidenceSources,
        catalogueCandidates: detection.catalogueCandidates,
        evidence: "[redacted]",
      })),
    },
  };
}

async function analyseClip({ clipPath, clipIndex, durationMs, file, apiKey }) {
  const google = createGoogleGenerativeAI({ apiKey });
  const clipId = `clip-${clipIndex + 1}`;
  const clipHash = await hashFile(clipPath);
  const results = [];

  for (const model of MODELS) {
    console.log(`  Analysing with ${model}...`);
    const startedAt = Date.now();
    const response = await generateText({
      model: google(model),
      output: Output.object({ schema: videoDetectionSchema }),
      system: buildPrompt(durationMs),
      messages: [{
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "url", url: new URL(file.uri) },
            mediaType: file.mimeType ?? MIME_TYPES[extname(clipPath).toLowerCase()],
          },
          {
            type: "text",
            text: "Analyse this single room survey clip. The room name is deliberately omitted for the spike; infer only a generic room type.",
          },
        ],
      }],
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const elapsedMs = Date.now() - startedAt;
    if (response.output == null) throw new Error(`${model} returned no structured output.`);
    const normalised = validateAndNormalise(response.output, durationMs);
    const usage = calculateCost(model, response.usage);
    const privateResult = {
      runAt: new Date().toISOString(),
      fixtureVersion: 1,
      promptVersion: PROMPT_VERSION,
      source: { clipId, durationMs, sha256: clipHash },
      model,
      elapsedMs,
      usage,
      checks: normalised.checks,
      result: normalised.output,
    };
    const fixture = redactedFixture({ clipId, model, durationMs, elapsedMs, usage, normalised });
    await writeFile(join(PRIVATE_RESULTS_DIR, `${clipId}-${model}.json`), `${JSON.stringify(privateResult, null, 2)}\n`);
    results.push({
      summary: { clipId, model, elapsedMs, usage, checks: normalised.checks },
      fixture,
    });
    console.log(
      `  ${normalised.checks.detectionCount} detections; ` +
      `${Math.round(normalised.checks.catalogueMatchRate * 100)}% catalogue-matched; ` +
      `${usage.inputTokens}+${usage.outputTokens} tokens; $${usage.estimatedCostUsd.toFixed(4)}.`,
    );
  }
  return results;
}

async function main() {
  const { help, clipPaths: requestedPaths } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local or the process environment.");

  const clipPaths = await discoverClips(requestedPaths);
  const clips = clipPaths.map((clipPath) => ({
    clipPath,
    durationMs: readDurationMs(clipPath),
  }));
  for (const [clipIndex, clip] of clips.entries()) {
    if (clip.durationMs < 10_000 || clip.durationMs > 90_000) {
      throw new Error(
        `clip-${clipIndex + 1} is ${Math.round(clip.durationMs / 1_000)}s; ` +
        "Phase 0 clips must be 10-90 seconds.",
      );
    }
  }
  if (!clips.some((clip) => clip.durationMs >= 30_000)) {
    throw new Error("At least one Phase 0 clip must be a representative 30-90 second walkthrough.");
  }
  await mkdir(PRIVATE_RESULTS_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  console.log(`Gemini credential loaded (${apiKey.slice(0, 5)}...).`);
  console.log(`Catalogue loaded: ${catalogueItems.length} items.`);

  const summary = [];
  for (const [clipIndex, { clipPath, durationMs }] of clips.entries()) {
    const clipId = `clip-${clipIndex + 1}`;
    if (durationMs < 30_000) console.log(`${clipId}: approved small-room exception.`);
    console.log(`${clipId}: ${Math.round(durationMs / 1_000)}s; uploading privately...`);
    let file;
    try {
      file = await uploadGeminiFile(clipPath, clipId, apiKey);
      console.log("  Provider file ACTIVE.");
      summary.push(...await analyseClip({ clipPath, clipIndex, durationMs, file, apiKey }));
    } finally {
      await deleteGeminiFile(file?.name, apiKey);
    }
  }

  const runs = summary.map((item) => item.summary);
  const totalCost = runs.reduce((sum, item) => sum + item.usage.estimatedCostUsd, 0);
  const automatedChecksPass = runs.length === 4 && runs.every((item) =>
    item.checks.schemaHonoured &&
    item.checks.timestampsSane &&
    item.checks.visualEvidenceDetected &&
    item.checks.audioEvidenceDetected &&
    item.checks.invalidCandidateCount === 0 &&
    item.checks.detectionCount > 0,
  );
  const summaryPath = join(PRIVATE_RESULTS_DIR, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify({
    runAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    models: MODELS,
    automatedChecksPass,
    humanCatalogueReviewRequired: true,
    totalEstimatedCostUsd: totalCost,
    runs,
  }, null, 2)}\n`);

  if (automatedChecksPass) {
    for (const item of summary) {
      await writeFile(
        join(FIXTURE_DIR, `${item.summary.clipId}-${item.summary.model}.json`),
        `${JSON.stringify(item.fixture, null, 2)}\n`,
      );
    }
  }

  console.log(`\nAutomated spike checks: ${automatedChecksPass ? "PASS" : "FAIL"}`);
  console.log(`Total estimated provider cost: $${totalCost.toFixed(4)}`);
  console.log(`Private review report: ${summaryPath}`);
  console.log(`Redacted fixtures: ${FIXTURE_DIR}`);
  console.log("FINAL GATE: pending estimator comparison of detections against both real rooms.");
  if (!automatedChecksPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`AI spike failed: ${error.message}`);
  process.exitCode = 1;
});
