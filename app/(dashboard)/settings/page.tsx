import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { getEditablePricing } from "@/lib/quote/pricing-config";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { PricingForm } from "@/components/settings/pricing-form";
import { MarginCalculator } from "@/components/settings/margin-calculator";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [profile, sb] = await Promise.all([getSessionProfile(), createClient()]);
  const [settings, pricing] = await Promise.all([getBusinessSettings(sb), getEditablePricing(sb)]);
  const canEdit = profile?.role === "admin";

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Settings" title="Settings" />

      <div className="grid gap-6">
        <PricingForm initial={pricing} canEdit={canEdit} />
        <SettingsForm initial={settings} canEdit={canEdit} />
        <MarginCalculator settings={settings} />
      </div>
    </main>
  );
}
