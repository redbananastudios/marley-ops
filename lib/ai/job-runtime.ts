import "server-only";

import { calculateAiCallCostUsd, estimateAiCallCost, gbpToUsd, isApprovedAiModelId } from "@/lib/ai/budget";
import { analyseGeminiMedia } from "@/lib/ai/gemini";
import type { AiJobProcessResult, AiJobRuntime } from "@/lib/ai/jobs";
import { AI_SURVEY_PROMPT_VERSION, importedVideoPrompt, photoPrompt, roomVideoPrompt } from "@/lib/ai/prompts";
import { photoDetectionSchema, videoDetectionSchema } from "@/lib/ai/survey-schema";
import { validatePhotoOutput, validateVideoOutput } from "@/lib/ai/validate";
import { createMediaStore } from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import type { Database } from "@/lib/supabase/database.types";

type Job = Database["public"]["Tables"]["ai_jobs"]["Row"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "AI processing failed";
}

async function withLeaseHeartbeat<T>(heartbeat: () => Promise<void>, task: () => Promise<T>): Promise<T> {
  let leaseError: unknown = null;
  const timer = setInterval(() => {
    void heartbeat().catch((error) => { leaseError = error; });
  }, 60_000);
  try {
    const result = await task();
    if (leaseError) throw leaseError;
    await heartbeat();
    return result;
  } finally {
    clearInterval(timer);
  }
}

export function createAiJobRuntime(): AiJobRuntime<Job> {
  const admin = createAdminClient();
  let staleReservationsSwept = false;

  return {
    async claimNext(workerId) {
      if (!staleReservationsSwept) {
        await admin.rpc("release_stale_ai_reservations", { p_age_minutes: 30 });
        staleReservationsSwept = true;
      }
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
        .select("id, survey_id, room_id, kind, storage_path, mime, duration_s, bytes")
        .eq("id", job.media_id)
        .maybeSingle();
      if (!media) throw new Error("Job media was not found");
      const { data: settings } = await admin
        .from("business_settings")
        .select("ai_model_default, ai_model_escalation, ai_monthly_alert_gbp")
        .eq("id", true)
        .single();
      const defaultModel = isApprovedAiModelId(settings?.ai_model_default)
        ? settings.ai_model_default
        : "gemini-3.5-flash";
      const escalationModel = isApprovedAiModelId(settings?.ai_model_escalation) ? settings.ai_model_escalation : defaultModel;
      const escalatedAttempt = job.attempts > 1;
      const model = escalatedAttempt ? escalationModel : defaultModel;
      const estimate = estimateAiCallCost({ durationS: Math.max(media.duration_s ?? 1, 1), model });
      if (media.kind === "photo" && !media.room_id) throw new Error("Photo media must belong to a room");
      const attemptKey = `${job.id}:${job.attempts}`;
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
      const month = new Date().toISOString().slice(0, 7) + "-01";
      const { data: monthSpend } = await admin.from("ai_spend_months").select("spent_usd, reserved_usd, alerted_at").eq("month", month).maybeSingle();
      if (monthSpend && !monthSpend.alerted_at && Number(monthSpend.spent_usd) + Number(monthSpend.reserved_usd) >= gbpToUsd(Number(settings?.ai_monthly_alert_gbp ?? 40))) {
        const { data: claimedAlert } = await admin.from("ai_spend_months").update({ alerted_at: new Date().toISOString() }).eq("month", month).is("alerted_at", null).select("month").maybeSingle();
        if (claimedAlert) await sendOpsAlert("AI survey monthly spend alert", [`Gemini spend plus live reservations has reached $${(Number(monthSpend.spent_usd) + Number(monthSpend.reserved_usd)).toFixed(2)} this month.`, "Review the AI Survey controls in Marley Ops Settings."]);
      }

      const { data: run, error: runError } = await admin
        .from("cubic_analysis_runs")
        .insert({
          survey_id: job.survey_id,
          media_id: media.id,
          model,
          prompt_version: AI_SURVEY_PROMPT_VERSION,
          purpose: escalatedAttempt ? "escalation" : media.kind === "import_video" && !media.room_id ? "segmentation" : "itemise",
          attempt_key: attemptKey,
          reserved_cost_usd: estimate.estimatedCostUsd,
        })
        .select("id")
        .single();
      if (runError || !run) {
        await admin.rpc("release_ai_call", { p_attempt_key: attemptKey });
        throw runError ?? new Error("Could not create analysis run");
      }

      let providerFileUploaded = false;
      try {
        const analysisResult = await withLeaseHeartbeat(context.heartbeat, async () => {
        const store = createMediaStore();
        const metadata = await store.getObjectMetadata(media.storage_path);
        const sourceUrl = await store.createSignedGetUrl(media.storage_path, 900);
        let analysis;
        let validated;
        if (media.kind === "photo") {
          const { data: room } = await admin.from("cubic_survey_rooms").select("name").eq("id", media.room_id!).single();
          analysis = await analyseGeminiMedia({ sourceUrl, bytes: metadata.bytes, mime: media.mime, model, prompt: photoPrompt(room?.name ?? "Room"), schema: photoDetectionSchema, displayName: `marley-${media.id}`, onFileUploaded: async (name) => { providerFileUploaded = true; await admin.from("cubic_analysis_runs").update({ provider_file_name: name }).eq("id", run.id); } });
          validated = validatePhotoOutput(analysis.output, { kind: "photo", roomId: media.room_id!, photoCount: 1 });
        } else {
          const { data: room } = media.room_id
            ? await admin.from("cubic_survey_rooms").select("name, room_type, floor, hidden_storage_checked").eq("id", media.room_id).single()
            : { data: null };
          const roomScoped = media.kind === "room_video" || !!media.room_id;
          analysis = await analyseGeminiMedia({ sourceUrl, bytes: metadata.bytes, mime: media.mime, model, prompt: roomScoped ? roomVideoPrompt(room?.name ?? "Room", { roomType: room?.room_type, floor: room?.floor, hiddenStorageChecked: room?.hidden_storage_checked }) : importedVideoPrompt(), schema: videoDetectionSchema, displayName: `marley-${media.id}`, onFileUploaded: async (name) => { providerFileUploaded = true; await admin.from("cubic_analysis_runs").update({ provider_file_name: name }).eq("id", run.id); } });
          if (roomScoped) {
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
        return { analysis, validated };
        });
        const { analysis, validated } = analysisResult;
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
        const { data: surveyDetections } = await admin
          .from("cubic_ai_detections")
          .select("id, room_id, catalogue_key, run:cubic_analysis_runs(media_id)")
          .eq("survey_id", job.survey_id)
          .eq("state", "proposed")
          .not("room_id", "is", null)
          .not("catalogue_key", "is", null);
        const groups = new Map<string, { ids: string[]; media: Set<string> }>();
        for (const detection of surveyDetections ?? []) {
          const key = `${detection.room_id}:${detection.catalogue_key}`;
          const group = groups.get(key) ?? { ids: [], media: new Set<string>() };
          group.ids.push(detection.id);
          if (detection.run?.media_id) group.media.add(detection.run.media_id);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          if (group.media.size > 1) await admin.from("cubic_ai_detections").update({ review_reason: "seen-in-multiple-clips" }).in("id", group.ids);
        }
        return { status: "done" };
      } catch (error) {
        if (providerFileUploaded) {
          await admin.rpc("finalise_ai_call", { p_attempt_key: attemptKey, p_actual_usd: estimate.estimatedCostUsd });
        } else {
          await admin.rpc("release_ai_call", { p_attempt_key: attemptKey });
        }
        await admin.from("cubic_analysis_runs").update({ status: "failed", cost_usd: providerFileUploaded ? estimate.estimatedCostUsd : null, error: errorMessage(error), finished_at: new Date().toISOString() }).eq("id", run.id).eq("status", "running");
        throw error;
      }
    },

    async complete() {
      // complete_ai_media_job commits the job and all dependent state atomically.
    },

    async block(jobId, workerId, reason) {
      const { error } = await admin.from("ai_jobs").update({ status: "blocked", error: reason, next_run_at: new Date(Date.now() + 300_000).toISOString(), locked_by: null, locked_at: null, lease_expires_at: null, heartbeat_at: null }).eq("id", jobId).eq("status", "running").eq("locked_by", workerId);
      if (error) throw error;
      const { data: job } = await admin.from("ai_jobs").select("media_id").eq("id", jobId).maybeSingle();
      if (job?.media_id) {
        const { data: media } = await admin.from("cubic_survey_media").update({ status: "failed", error: reason }).eq("id", job.media_id).select("room_id").maybeSingle();
        if (media?.room_id) await admin.rpc("recompute_ai_room_state", { p_room_id: media.room_id });
      }
    },

    async fail(jobId, workerId, error) {
      const { data: failedJob, error: failError } = await admin.rpc("fail_ai_job", {
        p_job_id: jobId,
        p_worker: workerId,
        p_error: errorMessage(error),
      });
      if (failError) throw failError;
      if (failedJob?.status === "dead") await sendOpsAlert("AI survey job exhausted retries", [`Job ${failedJob.id} could not process its survey media after ${failedJob.attempts} attempts.`, `Last error: ${errorMessage(error)}`]);
    },
  };
}
