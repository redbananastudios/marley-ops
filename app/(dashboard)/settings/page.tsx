import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { getEditablePricing } from "@/lib/quote/pricing-config";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { PricingForm } from "@/components/settings/pricing-form";
import { MarginCalculator } from "@/components/settings/margin-calculator";
import { TeamForm, type TeamMember } from "@/components/settings/team-form";
import { HealthCard } from "@/components/settings/health-card";
import { AiSettingsCard } from "@/components/settings/ai-settings-card";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [profile, sb] = await Promise.all([getSessionProfile(), createClient()]);
  const [settings, pricing] = await Promise.all([getBusinessSettings(sb), getEditablePricing(sb)]);
  const canEdit = profile?.role === "admin";
  const admin = createAdminClient();
  const month = new Date();
  month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const [{ data: spend }, { data: mediaRows }, { data: problemJobs }] = await Promise.all([
    admin.from("ai_spend_months").select("spent_usd").eq("month", month.toISOString().slice(0, 10)).maybeSingle(),
    admin.from("cubic_survey_media").select("bytes").neq("status", "deleted"),
    admin.from("ai_jobs").select("id, status, attempts, max_attempts, error, created_at").in("status", ["failed", "dead", "blocked"]).order("created_at", { ascending: false }).limit(20),
  ]);
  const aiConfigured = !!process.env.GEMINI_API_KEY && !!process.env.GEMINI_API_BASE_URL && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);

  // Team management is admin-only — estimators don't see the card at all.
  let team: TeamMember[] = [];
  if (canEdit) {
    const { data } = await sb
      .from("profiles")
      .select("id, full_name, email, role, active")
      .order("full_name", { ascending: true });
    team = (data ?? []) as TeamMember[];
  }

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Settings" title="Settings" />

      <div className="grid gap-6">
        {canEdit ? <TeamForm users={team} meId={profile?.id ?? null} /> : null}
        <AiSettingsCard settings={settings} spentUsd={Number(spend?.spent_usd ?? 0)} mediaBytes={(mediaRows ?? []).reduce((sum, row) => sum + Number(row.bytes ?? 0), 0)} configured={aiConfigured} canEdit={canEdit} problemJobs={problemJobs ?? []} />
        <PricingForm initial={pricing} canEdit={canEdit} />
        <SettingsForm initial={settings} canEdit={canEdit} />
        <MarginCalculator settings={settings} />
        <HealthCard />
      </div>
    </main>
  );
}
