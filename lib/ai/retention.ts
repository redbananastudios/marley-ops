import "server-only";

import { deleteGeminiProviderFile } from "@/lib/ai/gemini";
import { createMediaStore } from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AiRetentionResult { surveys: number; mediaDeleted: number; providerFilesDeleted: number; failures: number }

export async function runAiRetention(now = new Date()): Promise<AiRetentionResult> {
  const admin = createAdminClient();
  const result: AiRetentionResult = { surveys: 0, mediaDeleted: 0, providerFilesDeleted: 0, failures: 0 };
  const terminalCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const abandonedCutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const { data: candidates, error } = await admin
    .from("cubic_surveys")
    .select("id, ai_consent_withdrawn_at, media_retention_anchor_at, last_ai_user_activity_at, ai_status")
    .eq("legal_hold", false)
    .or(`ai_consent_withdrawn_at.not.is.null,media_retention_anchor_at.lt.${terminalCutoff},and(ai_status.in.(active,ready,failed,abandoned),last_ai_user_activity_at.lt.${abandonedCutoff})`);
  if (error) throw error;
  const store = createMediaStore();

  for (const survey of candidates ?? []) {
    result.surveys += 1;
    const { data: mediaRows } = await admin
      .from("cubic_survey_media")
      .select("id, storage_path, frames, status")
      .eq("survey_id", survey.id)
      .neq("status", "deleted");
    for (const media of mediaRows ?? []) {
      const framePaths = Array.isArray(media.frames)
        ? media.frames.flatMap((frame) => frame && typeof frame === "object" && !Array.isArray(frame) && typeof frame.path === "string" ? [frame.path] : [])
        : [];
      try {
        await store.deleteObjects([media.storage_path, ...framePaths]);
        await admin.from("cubic_survey_media").update({ status: "deleted", bytes: 0, frames: [], error: null }).eq("id", media.id);
        result.mediaDeleted += 1;
      } catch (deleteError) {
        await admin.from("cubic_survey_media").update({ status: "deletion_pending", error: deleteError instanceof Error ? deleteError.message.slice(0, 500) : "Media deletion failed" }).eq("id", media.id);
        result.failures += 1;
      }
    }
    const { data: runs } = await admin
      .from("cubic_analysis_runs")
      .select("id, provider_file_name")
      .eq("survey_id", survey.id)
      .not("provider_file_name", "is", null)
      .is("provider_deleted_at", null);
    for (const run of runs ?? []) {
      try {
        if (run.provider_file_name && await deleteGeminiProviderFile(run.provider_file_name)) {
          await admin.from("cubic_analysis_runs").update({ provider_deleted_at: now.toISOString() }).eq("id", run.id);
          result.providerFilesDeleted += 1;
        } else {
          result.failures += 1;
        }
      } catch {
        result.failures += 1;
      }
    }
  }
  return result;
}
