import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { z } from "zod";

import { ReviewWorkspace, type ReviewDetection, type ReviewMedia, type ReviewSegment } from "@/components/ai-survey/review-workspace";
import { SurveyStatePoller } from "@/components/ai-survey/survey-state-poller";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { CUBIC_CATEGORIES } from "@/lib/cubic-catalogue";
import { getBusinessSettings } from "@/lib/settings";
import { createMediaStore } from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function AiSurveyReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ room?: string }> }) {
  const { id: leadId } = await params;
  const requestedRoom = (await searchParams).room;
  if (!z.string().uuid().safeParse(leadId).success || !(await requireOfficeProfile())) notFound();
  const admin = createAdminClient();
  const { data: survey } = await admin
    .from("cubic_surveys")
    .select("id, updated_at, room_manifest_complete, ai_consent_withdrawn_at, ai_status, total_ft3, contingency_pct, planning_ready, lead:leads(name)")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (!survey || survey.ai_consent_withdrawn_at || survey.ai_status === "abandoned") notFound();
  const [{ data: rooms }, { data: detections }, { data: mediaRows }, { data: segmentRows }, settings] = await Promise.all([
    admin.from("cubic_survey_rooms").select("id, name, status, coverage").eq("survey_id", survey.id).order("sort"),
    admin.from("cubic_ai_detections").select("id, room_id, segment_id, label, catalogue_key, candidates, qty, confidence, moving, flags, evidence, review_reason, resolution, state, run:cubic_analysis_runs(media_id)").eq("survey_id", survey.id).order("created_at"),
    admin.from("cubic_survey_media").select("id, room_id, kind, storage_path, status").eq("survey_id", survey.id).in("status", ["processed", "processing", "uploaded"]),
    admin.from("cubic_survey_segments").select("id, media_id, proposed_name, start_s, end_s, room_id, status").eq("survey_id", survey.id).order("start_s"),
    getBusinessSettings(admin),
  ]);
  const store = createMediaStore();
  const media: ReviewMedia[] = [];
  for (const row of mediaRows ?? []) {
    try {
      media.push({ id: row.id, roomId: row.room_id, kind: row.kind, url: await store.createSignedGetUrl(row.storage_path, 3600) });
    } catch {
      // Evidence remains reviewable as an item list if a signed preview fails.
    }
  }
  for (const segment of segmentRows ?? []) {
    if (!segment.room_id) continue;
    const source = media.find((item) => item.id === segment.media_id);
    if (source && !media.some((item) => item.roomId === segment.room_id)) media.push({ ...source, roomId: segment.room_id });
  }
  const reviewDetections: ReviewDetection[] = (detections ?? []).map((row) => ({
    id: row.id, roomId: row.room_id, segmentId: row.segment_id, mediaId: row.run?.media_id ?? null, label: row.label, catalogueKey: row.catalogue_key,
    candidates: Array.isArray(row.candidates) ? row.candidates as never : [], qty: row.qty,
    confidence: Number(row.confidence), moving: row.moving,
    flags: row.flags && typeof row.flags === "object" && !Array.isArray(row.flags) ? row.flags as never : {},
    evidence: row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence) ? row.evidence as never : {},
    resolution: row.resolution && typeof row.resolution === "object" && !Array.isArray(row.resolution) ? row.resolution as never : null,
    reviewReason: row.review_reason, state: row.state,
  }));
  const catalogue = CUBIC_CATEGORIES.flatMap((category) => category.items.map((item) => ({ key: item.key, title: item.title, ft3: item.ft3, category: category.key })));
  const segments: ReviewSegment[] = (segmentRows ?? []).map((segment) => ({ id: segment.id, proposedName: segment.proposed_name, startS: Number(segment.start_s), endS: Number(segment.end_s), roomId: segment.room_id, status: segment.status }));

  return <main className="w-full px-4 pb-10 md:px-7">
    <SurveyStatePoller surveyId={survey.id} enabled={(rooms ?? []).some((room) => room.status === "processing")} />
    <header className="flex items-center justify-between gap-4 py-4"><div><Link href={`/leads/${leadId}/cubic`} className="focus-ring inline-flex min-h-10 items-center gap-1 rounded text-sm font-medium text-mist-500"><ChevronLeft className="size-4" /> Cubic survey</Link><h1 className="font-display text-2xl font-bold">Review AI inventory</h1><p className="mt-1 text-sm text-mist-500">{survey.lead?.name ?? "Estimator survey"} · verify every room before adding it to the quote</p></div><Link href={`/leads/${leadId}/cubic/review`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold"><RefreshCw className="size-4" /> Refresh analysis</Link></header>
    <ReviewWorkspace surveyId={survey.id} leadId={leadId} initialRoomId={(rooms ?? []).some((room) => room.id === requestedRoom) ? requestedRoom : undefined} initialUpdatedAt={survey.updated_at} manifestComplete={survey.room_manifest_complete} initialRawFt3={Number(survey.total_ft3)} contingencyPct={survey.contingency_pct} planningReady={survey.planning_ready} groundedReplayEnabled={settings.aiGroundedReplayEnabled} capacities={{ fillPct: settings.cubicFillPct, transitFt3: settings.cubicTransitFt3, lutonFt3: settings.cubicLutonFt3, sevenFiveTFt3: settings.cubic75tFt3 }} rooms={rooms ?? []} media={media} detections={reviewDetections} catalogue={catalogue} initialSegments={segments} />
  </main>;
}
