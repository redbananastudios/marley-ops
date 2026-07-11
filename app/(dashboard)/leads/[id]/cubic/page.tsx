import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ChevronLeft, FileVideo, ScanLine } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBusinessSettings } from "@/lib/settings";
import { sanitizeCubicLines, type CubicLine } from "@/lib/cubic-survey";
import { saveCubicSurveyAction } from "@/app/actions/cubic-survey";
import { CubicBuilder } from "@/components/cubic/cubic-builder";
import { CopyCubicLinkButton } from "@/components/cubic/copy-cubic-link-button";
import { getSurveyPlanningState } from "@/lib/ai/planning";
import { SurveyRoomsStrip, type SurveyRoomState } from "@/components/ai-survey/survey-rooms-strip";
import { SurveyStatePoller } from "@/components/ai-survey/survey-state-poller";

/**
 * /leads/[id]/cubic — the estimator's tablet surface for the volume survey.
 * Gets-or-creates the lead's survey row on entry (like a draft quote), then
 * hands everything to the client builder with the save action pre-bound.
 */

export const dynamic = "force-dynamic";

export default async function CubicSurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const sb = await createClient();
  const { data: lead } = await sb.from("leads").select("id, name, client_id").eq("id", id).maybeSingle();
  if (!lead) notFound();

  // Get-or-create the survey row (unique per lead; loser of a race refetches).
  const admin = createAdminClient();
  const COLS = "id, items, notes, customer_notes, status, updated_at, ai_status, ai_consent_withdrawn_at, planning_ready, contingency_pct, total_ft3";
  let { data: survey } = await admin.from("cubic_surveys").select(COLS).eq("lead_id", id).maybeSingle();
  if (!survey) {
    const {
      data: { user },
    } = await sb.auth.getUser();
    const { data: created, error } = await admin
      .from("cubic_surveys")
      .insert({ lead_id: id, client_id: lead.client_id, created_by: user?.id, updated_by: user?.id } as never)
      .select(COLS)
      .single();
    if (error?.code === "23505") {
      ({ data: survey } = await admin.from("cubic_surveys").select(COLS).eq("lead_id", id).maybeSingle());
    } else {
      survey = created;
    }
  }
  if (!survey) notFound();

  const settings = await getBusinessSettings(sb);
  const lines: CubicLine[] = sanitizeCubicLines(survey.items) ?? [];
  const planning = getSurveyPlanningState({ rawFt3: Number(survey.total_ft3), aiStatus: survey.ai_status, planningReady: survey.planning_ready, contingencyPct: survey.contingency_pct });
  const [{ data: aiRooms }, { data: aiMedia }, { data: aiJobs }, { data: aiDetections }] = settings.aiSurveyEnabled ? await Promise.all([
    admin.from("cubic_survey_rooms").select("id, name, room_type, floor, hidden_storage_checked, status").eq("survey_id", survey.id).order("sort"),
    admin.from("cubic_survey_media").select("id, room_id, status").eq("survey_id", survey.id),
    admin.from("ai_jobs").select("id, media_id, status").eq("survey_id", survey.id),
    admin.from("cubic_ai_detections").select("room_id, state").eq("survey_id", survey.id).neq("state", "rejected"),
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const roomStates: SurveyRoomState[] = (aiRooms ?? []).map((room) => {
    const roomMedia = (aiMedia ?? []).filter((media) => media.room_id === room.id);
    const failedMedia = roomMedia.find((media) => media.status === "failed");
    const blockedJob = (aiJobs ?? []).find((job) => roomMedia.some((media) => media.id === job.media_id) && job.status === "blocked");
    const retryJob = (aiJobs ?? []).find((job) => job.media_id === failedMedia?.id && ["failed", "dead"].includes(job.status));
    const roomLines = lines.filter((line) => line.room === room.name && line.source === "ai");
    return { id: room.id, name: room.name, roomType: room.room_type, floor: room.floor, hiddenStorageChecked: room.hidden_storage_checked, status: blockedJob ? "blocked" : room.status, itemCount: (aiDetections ?? []).filter((item) => item.room_id === room.id).length, totalFt3: roomLines.reduce((sum, line) => sum + (line.flags?.notMoving ? 0 : line.unitFt3 * line.qty), 0), failedMediaId: blockedJob ? null : failedMedia?.id ?? null, retryJobId: retryJob?.id ?? null, manualFinishAvailable: room.status === "pending" && roomMedia.some((media) => media.status === "ignored") };
  });
  const canUseAi = settings.aiSurveyEnabled && survey.ai_status !== "abandoned" && !survey.ai_consent_withdrawn_at;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-10 md:px-8">
      <SurveyStatePoller surveyId={survey.id} enabled={roomStates.some((room) => room.status === "processing")} />
      <div className="flex items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <Link
            href={`/leads/${id}`}
            className="focus-ring inline-flex min-h-10 items-center gap-1 text-sm font-medium text-mist-500 hover:text-foreground"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            {lead.name || "Lead"}
          </Link>
          <h1 className="font-display text-2xl font-bold text-foreground">Cubic survey</h1>
        </div>
        <div className="flex items-center gap-2">
          {canUseAi && (
            <><Link href={`/leads/${id}/cubic/review`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold"><ScanLine className="size-4" /> Review</Link><Link href={`/leads/${id}/cubic/scan#import-media`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-mm-red px-4 text-sm font-semibold text-mm-red"><FileVideo className="size-4" /> Import video</Link><Link href={`/leads/${id}/cubic/scan`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep"><ScanLine className="size-4" /> AI room scan</Link></>
          )}
          <CopyCubicLinkButton surveyId={survey.id} />
        </div>
      </div>

      <SurveyRoomsStrip surveyId={survey.id} surveyUpdatedAt={survey.updated_at} leadId={id} rooms={roomStates} canUseAi={canUseAi} />

      <CubicBuilder
        mode="office"
        initialLines={lines}
        initialNotes={survey.notes ?? ""}
        customerNotes={survey.customer_notes ?? ""}
        initialStatus={survey.status ?? "draft"}
        initialUpdatedAt={survey.updated_at}
        capacities={{
          fillPct: settings.cubicFillPct,
          transitFt3: settings.cubicTransitFt3,
          lutonFt3: settings.cubicLutonFt3,
          sevenFiveTFt3: settings.cubic75tFt3,
        }}
        save={saveCubicSurveyAction.bind(null, survey.id)}
        leadId={id}
        planning={planning}
      />
    </main>
  );
}
