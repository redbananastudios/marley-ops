import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { SettingsForm } from "@/components/settings/settings-form";
import {
  BASE_PRICES,
  PACK_PRICES,
  ADDON_75T_BASE,
  FLOOR_PRICES,
  ADMIN_FEE,
  MILEAGE_RATE,
  CONGESTION_PER_VAN,
  VAT_RATE,
} from "@/lib/quote/constants";

export const dynamic = "force-dynamic";

const gbp = (n: number): string => "£" + Number(n).toLocaleString("en-GB");

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-mist-500">{label}</span>
      <span className="tabular text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const [profile, sb] = await Promise.all([getSessionProfile(), createClient()]);
  const settings = await getBusinessSettings(sb);
  const canEdit = profile?.role === "admin";

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Settings" title="Settings" />

      <div className="grid gap-6 lg:grid-cols-2">
        <SettingsForm initial={settings} canEdit={canEdit} />

        {/* Read-only: the customer-facing quote pricing (locked engine constants). */}
        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Quote pricing</h2>
            <p className="mt-0.5 text-xs text-mist-400">
              The customer-facing engine prices. Read-only — changing these is a code + test change.
            </p>
          </div>
          <div className="divide-y px-5 py-2">
            <PriceRow label="1 Luton van (base)" value={gbp(BASE_PRICES["1luton"])} />
            <PriceRow label="2 Luton vans (base)" value={gbp(BASE_PRICES["2luton"])} />
            <PriceRow label="3 Luton vans (base)" value={gbp(BASE_PRICES["3luton"])} />
            <PriceRow label="7.5t add-on (base)" value={gbp(ADDON_75T_BASE)} />
            <PriceRow label="Full packing (1 van)" value={gbp(PACK_PRICES["1luton"].full)} />
            <PriceRow label="Fragile packing (1 van)" value={gbp(PACK_PRICES["1luton"].fragile)} />
            <PriceRow label="Floor access (1st / 2nd / 3rd, per van)" value={`${gbp(FLOOR_PRICES["1st"])} / ${gbp(FLOOR_PRICES["2nd"])} / ${gbp(FLOOR_PRICES["3rd"])}`} />
            <PriceRow label="Mileage rate" value={`${gbp(MILEAGE_RATE)}/mile`} />
            <PriceRow label="Congestion (per van)" value={gbp(CONGESTION_PER_VAN)} />
            <PriceRow label="Admin fee" value={gbp(ADMIN_FEE)} />
            <PriceRow label="VAT rate" value={`${Math.round(VAT_RATE * 100)}%`} />
          </div>
        </Card>
      </div>
    </main>
  );
}
