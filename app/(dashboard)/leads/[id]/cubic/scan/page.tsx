import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { z } from "zod";

import { AiSurveyCapture } from "@/components/ai-survey/ai-survey-capture";
import { SurveyStatePoller } from "@/components/ai-survey/survey-state-poller";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function AiSurveyScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  if (!z.string().uuid().safeParse(leadId).success) notFound();
  if (!(await requireOfficeProfile())) notFound();

  const admin = createAdminClient();
  const [{ data: survey }, { data: settings }] = await Promise.all([admin
    .from("cubic_surveys")
    .select("id, ai_consent, ai_consent_withdrawn_at, ai_status, lead:leads(name)")
    .eq("lead_id", leadId)
    .maybeSingle(), admin.from("business_settings").select("ai_survey_enabled").eq("id", true).maybeSingle()]);
  if (!survey || !settings?.ai_survey_enabled || survey.ai_consent_withdrawn_at || survey.ai_status === "abandoned") notFound();
  const { data: rooms } = await admin
    .from("cubic_survey_rooms")
    .select("id, name, status")
    .eq("survey_id", survey.id)
    .order("sort");

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-10 md:px-7">
      <SurveyStatePoller surveyId={survey.id} enabled={(rooms ?? []).some((room) => room.status === "processing")} />
      <header className="flex items-center justify-between gap-4 py-4">
        <div>
          <Link href={`/leads/${leadId}/cubic`} className="focus-ring inline-flex min-h-10 items-center gap-1 rounded text-sm font-medium text-mist-500 hover:text-foreground"><ChevronLeft className="size-4" /> Cubic survey</Link>
          <h1 className="font-display text-2xl font-bold">AI room capture</h1>
          <p className="mt-1 text-sm text-mist-500">{survey.lead?.name ?? "Estimator survey"} · record one slow walkthrough per room</p>
        </div>
      </header>
      <AiSurveyCapture surveyId={survey.id} initialConsent={!!survey.ai_consent} initialRooms={rooms ?? []} />
    </main>
  );
}
