import "server-only";

import { randomUUID } from "node:crypto";

import { calculateAiCallCostUsd, estimateAiCallCost, isApprovedAiModelId } from "@/lib/ai/budget";
import { analyseGeminiMedia } from "@/lib/ai/gemini";
import type { AiJobProcessResult, AiJobRuntime } from "@/lib/ai/jobs";
import { AI_SURVEY_PROMPT_VERSION, importedVideoPrompt, photoPrompt, roomVideoPrompt } from "@/lib/ai/prompts";
import { photoDetectionSchema, videoDetectionSchema } from "@/lib/ai/survey-schema";
import { validatePhotoOutput, validateVideoOutput } from "@/lib/ai/validate";
import { createMediaStore } from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Job = Database["public"]["Tables"]["ai_jobs"]["Row"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "AI processing failed";
}

async function storedBytes(storagePath: string): Promise<Uint8Array> {
  const url = await createMediaStore().createSignedGetUrl(storagePath, 900);
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export function createAiJobRuntime(): AiJobRuntime<Job> {
  const admin = createAdminClient();

  return {
    async claimNext(workerId) {
      const { data, error } = await admin.rpc("claim_ai_jobs", {
        p_worker: workerId,
        p_batch: 1,
        p_lease_seconds: 300,
      });
      if (error) throw error;
      return data?.[0] ?? null;
    },

    async heartbeat(jobId, workerId) {
      const { data, error } = await admin.rpc("heartbeat_ai_job", {
        p_job_id: jobId,
        p_worker: workerId,
        p_lease_seconds: 300,
      });
      if (error || !data) throw error ?? new Error("AI job lease was lost");
    },

    async process(job, context): Promise<AiJobProcessResult> {
      if (job.kind !== "process_media" || !job.media_id) {
        return { status: "blocked", reason: "unsupported_job_kind" };
      }
      const { data: media } = await admin
        .from("cubic_survey_media")
        .select("id, survey_id, room_id, kind, storage_path, mime, duration_s")
        .eq("id", job.media_id)
        .maybeSingle();
      if (!media) throw new Error("Job media was not found");
      const { data: settings } = await admin
        .from("business_settings")
        .select("ai_model_default")
        .eq("id", true)
        .single();
      const model = isApprovedAiModelId(settings?.ai_model_default)
        ? settings.ai_model_default
        : "gemini-3.5-flash";
      const estimate = estimateAiCallCost({ durationS: Math.max(media.duration_s ?? 1, 1), model });
      const attemptKey = `${job.id}:${job.attempts}:${randomUUID()}`;
      const { data: reservation, error: reservationError } = await admin.rpc("reserve_ai_call", {
        p_survey_id: job.survey_id,
        p_job_id: job.id,
        p_attempt_key: attemptKey,
        p_estimated_usd: estimate.estimatedCostUsd,
      });
      if (reservationError) throw reservationError;
      if (!reservation?.[0]?.allowed) {
        return { status: "blocked", reason: reservation?.[0]?.reason ?? "budget_cap" };
      }

      const { data: run, error: runError } = await admin
        .from("cubic_analysis_runs")
        .insert({
          survey_id: job.survey_id,
          media_id: media.id,
          model,
          prompt_version: AI_SURVEY_PROMPT_VERSION,
          purpose: "itemise",
          attempt_key: attemptKey,
          reserved_cost_usd: estimate.estimatedCostUsd,
        })
        .select("id")
        .single();
      if (runError || !run) {
        await admin.rpc("release_ai_call", { p_attempt_key: attemptKey });
        throw runError ?? new Error("Could not create analysis run");
      }

      try {
        await context.heartbeat();
        const bytes = await storedBytes(media.storage_path);
        let analysis;
        let validated;
        if (media.kind === "photo") {
          const { data: room } = await admin.from("cubic_survey_rooms").select("name").eq("id", media.room_id!).single();
          analysis = await analyseGeminiMedia({ bytes, mime: media.mime, model, prompt: photoPrompt(room?.name ?? "Room"), schema: photoDetectionSchema, displayName: `marley-${media.id}` });
          validated = validatePhotoOutput(analysis.output, { kind: "photo", roomId: media.room_id!, photoCount: 1 });
        } else {
          const { data: room } = media.room_id
            ? await admin.from("cubic_survey_rooms").select("name").eq("id", media.room_id).single()
            : { data: null };
          analysis = await analyseGeminiMedia({ bytes, mime: media.mime, model, prompt: media.kind === "room_video" ? roomVideoPrompt(room?.name ?? "Room") : importedVideoPrompt(), schema: videoDetectionSchema, displayName: `marley-${media.id}` });
          if (media.kind === "room_video") {
            validated = validateVideoOutput(analysis.output, { kind: "room_video", roomId: media.room_id!, durationS: media.duration_s ?? 1 });
          } else {
            const proposed = analysis.output.roomAssessment.proposedRooms ?? [];
            if (proposed.length === 0) throw new Error("Whole-property video returned no room segments");
            const { data: segments, error: segmentError } = await admin
              .from("cubic_survey_segments")
              .upsert(proposed.map((segment) => ({
                survey_id: media.survey_id,
                media_id: media.id,
                model_ref: segment.ref,
                proposed_name: segment.name,
                start_s: segment.startS,
                end_s: segment.endS,
              })), { onConflict: "media_id,model_ref" })
              .select("id, model_ref, room_id, start_s, end_s");
            if (segmentError || !segments) throw segmentError ?? new Error("Could not persist room segments");
            validated = validateVideoOutput(analysis.output, {
              kind: "import_video",
              durationS: media.duration_s ?? 1,
              segments: segments.map((segment) => ({ id: segment.id, modelRef: segment.model_ref, roomId: segment.room_id, startS: segment.start_s, endS: segment.end_s })),
            });
          }
        }
        if (!validated.ok) throw new Error(validated.error);
        await context.heartbeat();
        const actualCost = calculateAiCallCostUsd(model, analysis.inputTokens, analysis.outputTokens);
        const detections = validated.data.items.map((item) => ({
          roomId: item.roomId,
          segmentId: item.evidence.kind === "video" ? item.evidence.segmentId ?? null : null,
          label: item.label,
          catalogueKey: item.catalogueKey,
          candidates: item.catalogueCandidates,
          qty: item.qty,
          confidence: item.catalogueCandidates[0]?.confidence ?? 0,
          moving: item.moving,
          flags: item.flags,
          evidence: item.evidence,
          reviewReason: item.reviewReason,
        }));
        const { error: completeError } = await admin.rpc("complete_ai_media_job", {
          p_job_id: job.id,
          p_worker: context.workerId,
          p_run_id: run.id,
          p_detections: detections as never,
          p_coverage: validated.data.roomAssessment.coverage,
          p_quality_flags: validated.data.roomAssessment.qualityFlags,
          p_quality_warnings: validated.data.roomAssessment.warningNotes,
          p_input_tokens: analysis.inputTokens,
          p_output_tokens: analysis.outputTokens,
          p_actual_usd: actualCost,
          p_provider_deleted: analysis.providerFileDeleted,
        });
        if (completeError) throw completeError;
        return { status: "done" };
      } catch (error) {
        await admin.rpc("release_ai_call", { p_attempt_key: attemptKey });
        await admin.from("cubic_analysis_runs").update({ status: "failed", error: errorMessage(error), finished_at: new Date().toISOString() }).eq("id", run.id).eq("status", "running");
        throw error;
      }
    },

    async complete() {
      // complete_ai_media_job commits the job and all dependent state atomically.
    },

    async block(jobId, workerId, reason) {
      const { error } = await admin.from("ai_jobs").update({ status: "blocked", error: reason, locked_by: null, locked_at: null, lease_expires_at: null, heartbeat_at: null }).eq("id", jobId).eq("status", "running").eq("locked_by", workerId);
      if (error) throw error;
    },

    async fail(jobId, workerId, error) {
      const { error: failError } = await admin.rpc("fail_ai_job", {
        p_job_id: jobId,
        p_worker: workerId,
        p_error: errorMessage(error),
      });
      if (failError) throw failError;
    },
  };
}
