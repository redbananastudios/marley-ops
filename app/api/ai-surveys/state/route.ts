import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await requireOfficeProfile())) {
    return NextResponse.json({ error: "Office access required" }, { status: 403 });
  }
  const surveyId = z.string().uuid().safeParse(new URL(request.url).searchParams.get("surveyId"));
  if (!surveyId.success) {
    return NextResponse.json({ error: "Invalid survey" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: survey } = await admin
    .from("cubic_surveys")
    .select("id, ai_status, updated_at")
    .eq("id", surveyId.data)
    .maybeSingle();
  if (!survey) return NextResponse.json({ error: "Survey not found" }, { status: 404 });

  const [{ data: rooms }, { data: media }] = await Promise.all([
    admin.from("cubic_survey_rooms").select("id, status, coverage, updated_at").eq("survey_id", survey.id).order("sort"),
    admin.from("cubic_survey_media").select("id, room_id, status, error, updated_at").eq("survey_id", survey.id).order("created_at"),
  ]);
  return NextResponse.json(
    { survey: { id: survey.id, status: survey.ai_status, updatedAt: survey.updated_at }, rooms: rooms ?? [], media: media ?? [] },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
