"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AI_MODEL_IDS } from "@/lib/ai/budget";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  enabled: z.boolean(),
  groundedReplayEnabled: z.boolean(),
  modelDefault: z.enum(AI_MODEL_IDS),
  modelEscalation: z.enum(AI_MODEL_IDS),
  surveyCapGbp: z.number().positive().max(100),
  monthlyCapGbp: z.number().positive().max(10000),
  monthlyAlertGbp: z.number().nonnegative().max(10000),
}).refine((value) => value.monthlyAlertGbp <= value.monthlyCapGbp, { message: "Monthly alert must not exceed the cap." });

export type AiSettingsInput = z.infer<typeof schema>;

export async function updateAiSettingsAction(raw: AiSettingsInput) {
  const input = schema.safeParse(raw);
  if (!input.success) return { ok: false as const, error: input.error.issues[0]?.message ?? "Check AI settings." };
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };
  const { data: profile } = await session.from("profiles").select("role, active").eq("id", user.id).maybeSingle();
  if (!profile?.active || profile.role !== "admin") return { ok: false as const, error: "Only admins can change AI settings." };
  const value = input.data;
  const { error } = await createAdminClient().from("business_settings").update({
    ai_survey_enabled: value.enabled,
    ai_grounded_replay_enabled: value.groundedReplayEnabled,
    ai_model_default: value.modelDefault,
    ai_model_escalation: value.modelEscalation,
    ai_survey_cap_gbp: value.surveyCapGbp,
    ai_monthly_cap_gbp: value.monthlyCapGbp,
    ai_monthly_alert_gbp: value.monthlyAlertGbp,
  }).eq("id", true);
  if (error) return { ok: false as const, error: "Could not save AI settings." };
  revalidatePath("/settings");
  return { ok: true as const };
}
