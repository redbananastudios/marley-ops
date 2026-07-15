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
import { QuickSigninCard } from "@/components/settings/quick-signin-card";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { SettingsNav, type SettingsSection } from "@/components/settings/settings-nav";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [profile, sb] = await Promise.all([getSessionProfile(), createClient()]);
  const [settings, pricing] = await Promise.all([getBusinessSettings(sb), getEditablePricing(sb)]);
  const canEdit = profile?.role === "admin";
  const admin = createAdminClient();
  const month = new Date();
  month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const historyStart = new Date(month); historyStart.setUTCMonth(historyStart.getUTCMonth() - 5);
  const nextSweep = new Date(); nextSweep.setUTCHours(2, 30, 0, 0); if (nextSweep <= new Date()) nextSweep.setUTCDate(nextSweep.getUTCDate() + 1);
  const [{ data: spendHistory }, { data: mediaRows }, { data: problemJobs }] = await Promise.all([
    admin.from("ai_spend_months").select("month, spent_usd, reserved_usd, alerted_at").gte("month", historyStart.toISOString().slice(0, 10)).order("month"),
    admin.from("cubic_survey_media").select("bytes, status").neq("status", "deleted"),
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

  // Pills follow the sections' DOM order below (Team → AI → Pricing → Business →
  // Margin → Health) so the active marker tracks scroll monotonically. Team only
  // exists for admins, so its pill is conditional too.
  const sections: SettingsSection[] = [
    ...(canEdit ? [{ id: "team", label: "Team" }] : []),
    { id: "quick-signin", label: "Quick sign-in" },
    { id: "notifications", label: "Notifications" },
    { id: "ai", label: "AI" },
    { id: "pricing", label: "Pricing" },
    { id: "business", label: "Business" },
    { id: "margin", label: "Margin" },
    { id: "health", label: "Health" },
  ];

  // min-w-0 is load-bearing: grid items default to min-width:auto, so the
  // pricing table's min-content width forced every card (and the page) wider
  // than a phone screen — the inner overflow-x-auto only works once the
  // section itself is allowed to shrink.
  const sectionClass = "min-w-0 scroll-mt-28 xl:scroll-mt-16";

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Settings" title="Settings" />

      <SettingsNav sections={sections} />

      <div className="grid gap-6">
        {canEdit ? (
          <section id="team" className={sectionClass}>
            <TeamForm users={team} meId={profile?.id ?? null} />
          </section>
        ) : null}
        <section id="quick-signin" className={sectionClass}>
          <QuickSigninCard />
        </section>
        <section id="notifications" className={sectionClass}>
          <NotificationsCard isAdmin={canEdit} />
        </section>
        <section id="ai" className={sectionClass}>
          <AiSettingsCard settings={settings} spendHistory={(spendHistory ?? []).map((item) => ({ month: item.month, spentUsd: Number(item.spent_usd), reservedUsd: Number(item.reserved_usd), alertedAt: item.alerted_at }))} mediaBytes={(mediaRows ?? []).reduce((sum, row) => sum + Number(row.bytes ?? 0), 0)} mediaCount={(mediaRows ?? []).length} nextRetentionSweep={nextSweep.toISOString()} diskCapacityGb={Number(process.env.AI_MEDIA_DISK_CAPACITY_GB) || null} configured={aiConfigured} canEdit={canEdit} problemJobs={problemJobs ?? []} />
        </section>
        <section id="pricing" className={sectionClass}>
          <PricingForm initial={pricing} canEdit={canEdit} />
        </section>
        <section id="business" className={sectionClass}>
          <SettingsForm initial={settings} canEdit={canEdit} />
        </section>
        <section id="margin" className={sectionClass}>
          <MarginCalculator settings={settings} />
        </section>
        <section id="health" className={sectionClass}>
          <HealthCard />
        </section>
      </div>
    </main>
  );
}
