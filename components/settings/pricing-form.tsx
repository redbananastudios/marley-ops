"use client";

/**
 * Editable quote prices — the van + 7.5t price grid that drives every new quote.
 * Admins only; saved to business_settings.pricing and merged over the code defaults.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VEHICLE_KEYS, VAN_COUNT } from "@/lib/quote/constants";
import { savePricingAction } from "@/app/(dashboard)/settings/actions";
import type { EditablePricing } from "@/lib/quote/pricing-config";

function PriceCell({
  value,
  disabled,
  onChange,
  prefix = "+",
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  prefix?: string;
}) {
  return (
    <div className="flex h-10 items-center rounded-md border border-input bg-card px-2.5 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30 has-disabled:opacity-60">
      <span className="mr-0.5 shrink-0 text-xs text-mist-400">{prefix}£</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="1"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="tabular h-full w-full bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function PricingForm({ initial, canEdit }: { initial: EditablePricing; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<EditablePricing>(initial);

  const setBase = (k: (typeof VEHICLE_KEYS)[number], v: string) =>
    setP((s) => ({ ...s, base: { ...s.base, [k]: Number(v) || 0 } }));
  const setPack = (k: (typeof VEHICLE_KEYS)[number], tier: "full" | "fragile", v: string) =>
    setP((s) => ({ ...s, pack: { ...s.pack, [k]: { ...s.pack[k], [tier]: Number(v) || 0 } } }));

  async function onSave() {
    setBusy(true);
    const res = await savePricingAction(p);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not save prices.");
      return;
    }
    toast.success("Quote prices saved.");
    router.refresh();
  }

  return (
    <Card className="p-0">
      <div className="border-b px-5 py-3.5">
        <h2 className="font-display text-lg font-semibold text-foreground">Quote prices</h2>
        <p className="mt-0.5 text-xs text-mist-400">Drives every new quote. Owner-pack is always £0.</p>
      </div>

      <div className="overflow-x-auto px-5 py-4">
        <table className="w-full min-w-[480px] border-separate border-spacing-y-2">
          <thead>
            <tr className="text-left">
              <th className="eyebrow pb-1 font-normal">Vehicle</th>
              <th className="eyebrow pb-1 font-normal">Base</th>
              <th className="eyebrow pb-1 font-normal">Full pack</th>
              <th className="eyebrow pb-1 font-normal">Fragile pack</th>
            </tr>
          </thead>
          <tbody>
            {VEHICLE_KEYS.map((k) => (
              <tr key={k}>
                <td className="pr-3 text-sm font-medium text-foreground">
                  {VAN_COUNT[k]} Luton {VAN_COUNT[k] === 1 ? "van" : "vans"}
                </td>
                <td className="pr-3">
                  <PriceCell prefix="" value={String(p.base[k])} disabled={!canEdit || busy} onChange={(v) => setBase(k, v)} />
                </td>
                <td className="pr-3">
                  <PriceCell value={String(p.pack[k].full)} disabled={!canEdit || busy} onChange={(v) => setPack(k, "full", v)} />
                </td>
                <td>
                  <PriceCell value={String(p.pack[k].fragile)} disabled={!canEdit || busy} onChange={(v) => setPack(k, "fragile", v)} />
                </td>
              </tr>
            ))}
            <tr>
              <td className="pr-3 text-sm font-medium text-foreground">7.5 tonne lorry</td>
              <td className="pr-3">
                <PriceCell
                  prefix=""
                  value={String(p.addon75Base)}
                  disabled={!canEdit || busy}
                  onChange={(v) => setP((s) => ({ ...s, addon75Base: Number(v) || 0 }))}
                />
              </td>
              <td className="pr-3">
                <PriceCell
                  value={String(p.addon75Pack.full)}
                  disabled={!canEdit || busy}
                  onChange={(v) => setP((s) => ({ ...s, addon75Pack: { ...s.addon75Pack, full: Number(v) || 0 } }))}
                />
              </td>
              <td>
                <PriceCell
                  value={String(p.addon75Pack.fragile)}
                  disabled={!canEdit || busy}
                  onChange={(v) => setP((s) => ({ ...s, addon75Pack: { ...s.addon75Pack, fragile: Number(v) || 0 } }))}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {canEdit ? (
        <div className="flex justify-end border-t px-5 py-4">
          <Button onClick={onSave} disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save prices
          </Button>
        </div>
      ) : (
        <div className="border-t px-5 py-3 text-xs text-mist-400">Only admins can change prices.</div>
      )}
    </Card>
  );
}
