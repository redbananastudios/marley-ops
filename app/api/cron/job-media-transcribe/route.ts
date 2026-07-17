import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import { analyseGeminiMedia } from "@/lib/ai/gemini";
import { JOB_MEDIA_BUCKET } from "@/lib/job-media";

/**
 * Voice-note transcription (every 5 min via /etc/cron.d/marley-ops). A
 * DELIBERATELY separate, lightweight queue — ai_jobs is constraint-locked to
 * cubic surveys (0031) and must not be destabilised for pennies-per-note work
 * (PRD v1.0 pressure-test). Claim is a conditional status flip, so concurrent
 * runs never double-transcribe; failures retry up to 3 attempts and then
 * surface in the review UI (no alerts — non-critical). Rows stranded in
 * 'running' by a dead runner are reaped to 'failed' at the top of each run.
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
    const summary = { reaped: 0, claimed: 0, done: 0, failed: 0, writeErrors: 0, inputTokens: 0, outputTokens: 0 };

    // Reap rows stranded in 'running' by a crashed/restarted run — the claim
    // refreshes updated_at, so >15 min old means the runner is dead. Flipping
    // to 'failed' (+1 attempt) puts them back under the normal retry cap.
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stranded } = await admin
      .from("job_media")
      .select("id, transcript_attempts")
      .eq("kind", "audio")
      .eq("transcript_status", "running")
      .lt("updated_at", staleCutoff);
    for (const s of stranded ?? []) {
      const { error: reapErr } = await admin
        .from("job_media")
        .update({
          transcript_status: "failed",
          transcript_error: "stranded — a previous run crashed or timed out",
          transcript_attempts: s.transcript_attempts + 1,
        } as never)
        .eq("id", s.id)
        .eq("transcript_status", "running");
      if (reapErr) summary.writeErrors += 1;
      else summary.reaped += 1;
    }

    const { data: candidates } = await admin
      .from("job_media")
      .select("id, storage_path, mime, bytes, transcript_attempts, transcript_status")
      .eq("kind", "audio")
      .in("transcript_status", ["pending", "failed"])
      .lt("transcript_attempts", 3)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    for (const row of candidates ?? []) {
      // Claim: CAS on status AND attempts — a concurrent run that already ran
      // this row (attempts bumped) can't be re-claimed from a stale snapshot,
      // and the cap holds even across overlapping runs.
      const { data: claimed } = await admin
        .from("job_media")
        .update({ transcript_status: "running" } as never)
        .eq("id", row.id)
        .in("transcript_status", ["pending", "failed"])
        .eq("transcript_attempts", row.transcript_attempts)
        .lt("transcript_attempts", 3)
        .select("id");
      if (!claimed?.length) continue;
      summary.claimed += 1;

      try {
        const store = createMediaStore(process.env, { bucket: JOB_MEDIA_BUCKET });
        let bytes = Number(row.bytes);
        if (!Number.isFinite(bytes) || bytes <= 0) {
          const info = await store.getObjectMetadata(row.storage_path).catch(() => null);
          bytes = Number(info?.bytes ?? 0);
        }
        if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("media size unavailable");

        const signedUrl = await store.createSignedGetUrl(row.storage_path, 3600).catch(() => null);
        if (!signedUrl) throw new Error("could not sign the media URL");

        const mime = (row.mime ?? "audio/mp4").split(";")[0];
        const analysis = await analyseGeminiMedia({
          sourceUrl: signedUrl,
          bytes,
          mime,
          displayName: `job-voice-${row.id}`,
          model: MODEL,
          schema: transcriptSchema,
          prompt: PROMPT,
        });

        const transcript = analysis.output.transcript.trim().slice(0, 8000);
        // A failed terminal write leaves the row 'running' — the reaper above
        // recovers it next run, so counting the miss is enough here.
        const { error: doneErr } = await admin
          .from("job_media")
          .update({
            transcript,
            transcript_status: "done",
            transcript_error: null,
            transcript_attempts: row.transcript_attempts + 1,
          } as never)
          .eq("id", row.id);
        if (doneErr) summary.writeErrors += 1;
        summary.done += 1;
        summary.inputTokens += analysis.inputTokens;
        summary.outputTokens += analysis.outputTokens;
      } catch (err) {
        const { error: failErr } = await admin
          .from("job_media")
          .update({
            transcript_status: "failed",
            transcript_error: err instanceof Error ? err.message.slice(0, 500) : "transcription failed",
            transcript_attempts: row.transcript_attempts + 1,
          } as never)
          .eq("id", row.id);
        if (failErr) summary.writeErrors += 1;
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
