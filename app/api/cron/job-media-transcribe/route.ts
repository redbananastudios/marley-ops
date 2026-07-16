import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyseGeminiMedia } from "@/lib/ai/gemini";
import { JOB_MEDIA_BUCKET } from "@/lib/job-media";

/**
 * Voice-note transcription (every 5 min via /etc/cron.d/marley-ops). A
 * DELIBERATELY separate, lightweight queue — ai_jobs is constraint-locked to
 * cubic surveys (0031) and must not be destabilised for pennies-per-note work
 * (PRD v1.0 pressure-test). Claim is a conditional status flip, so concurrent
 * runs never double-transcribe; failures retry up to 3 attempts and then
 * surface in the review UI (no alerts — non-critical).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = (process.env.JOB_MEDIA_TRANSCRIBE_MODEL === "gemini-3.5-flash"
  ? "gemini-3.5-flash"
  : "gemini-3.1-flash-lite") as "gemini-3.5-flash" | "gemini-3.1-flash-lite";
const BATCH = 5;

const transcriptSchema = z.object({
  transcript: z
    .string()
    .describe("The spoken content, verbatim in UK English, light punctuation, fillers dropped"),
});

const PROMPT =
  "Transcribe this voice note from a removals-company team member, verbatim in UK English. " +
  "Add light punctuation, drop filler sounds (um, er). If parts are inaudible write [inaudible]. " +
  "Return only the transcript.";

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("job-media-transcribe", async () => {
    const admin = createAdminClient();
    const summary = { claimed: 0, done: 0, failed: 0, inputTokens: 0, outputTokens: 0 };

    const { data: candidates } = await admin
      .from("job_media")
      .select("id, storage_path, mime, bytes, transcript_attempts, transcript_status")
      .eq("kind", "audio")
      .in("transcript_status", ["pending", "failed"])
      .lt("transcript_attempts", 3)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    for (const row of candidates ?? []) {
      // Claim: only one runner flips it to running (concurrent-cron safe).
      const { data: claimed } = await admin
        .from("job_media")
        .update({ transcript_status: "running" } as never)
        .eq("id", row.id)
        .in("transcript_status", ["pending", "failed"])
        .select("id");
      if (!claimed?.length) continue;
      summary.claimed += 1;

      try {
        let bytes = Number(row.bytes);
        if (!Number.isFinite(bytes) || bytes <= 0) {
          const { data: info } = await admin.storage.from(JOB_MEDIA_BUCKET).info(row.storage_path);
          bytes = Number(info?.size ?? 0);
        }
        if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("media size unavailable");

        const { data: signed, error: signErr } = await admin.storage
          .from(JOB_MEDIA_BUCKET)
          .createSignedUrl(row.storage_path, 3600);
        if (signErr || !signed?.signedUrl) throw new Error("could not sign the media URL");

        const mime = (row.mime ?? "audio/mp4").split(";")[0];
        const analysis = await analyseGeminiMedia({
          sourceUrl: signed.signedUrl,
          bytes,
          mime,
          displayName: `job-voice-${row.id}`,
          model: MODEL,
          schema: transcriptSchema,
          prompt: PROMPT,
        });

        const transcript = analysis.output.transcript.trim().slice(0, 8000);
        await admin
          .from("job_media")
          .update({
            transcript,
            transcript_status: "done",
            transcript_error: null,
            transcript_attempts: row.transcript_attempts + 1,
          } as never)
          .eq("id", row.id);
        summary.done += 1;
        summary.inputTokens += analysis.inputTokens;
        summary.outputTokens += analysis.outputTokens;
      } catch (err) {
        await admin
          .from("job_media")
          .update({
            transcript_status: "failed",
            transcript_error: err instanceof Error ? err.message.slice(0, 500) : "transcription failed",
            transcript_attempts: row.transcript_attempts + 1,
          } as never)
          .eq("id", row.id);
        summary.failed += 1;
      }
    }
    return summary;
  });

  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
