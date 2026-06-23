"use client";

/**
 * Business rates + costs form. The estimator fee is live (drives Performance + the
 * dashboard). The cost rates are captured ready for margin-per-job once the formula
 * is agreed. Admins only — when canEdit is false the fields are read-only.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateSettingsAction, type SettingsInput } from "@/app/(dashboard)/settings/actions";
import type { BusinessSettings } from "@/lib/settings";

interface FieldDef {
  key: keyof BusinessSettings;
  label: string;
  hint: string;
  unit: "£" | "£/mile" | "£/hour" | "£/day";
}

const FIELDS: FieldDef[] = [
  { key: "estimatorFee", label: "Estimator fee per visit", hint: "Paid per attended survey. Drives Performance + the dashboard.", unit: "£" },
  { key: "costFuelPerMile", label: "Fuel cost per mile", hint: "Internal cost. For margin once wired.", unit: "£/mile" },
  { key: "costLabourPerHour", label: "Labour cost per hour", hint: "Per mover. Internal cost.", unit: "£/hour" },
  { key: "costBox", label: "Box unit cost", hint: "Per box supplied. Internal cost.", unit: "£" },
  { key: "costVanDay", label: "Van day rate", hint: "Per van per day. Internal cost.", unit: "£/day" },
];

function MoneyInput({
  id,
  value,
  unit,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  unit: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex h-11 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30 has-disabled:opacity-60">
      <span className="mr-1 shrink-0 text-sm text-mist-400">£</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="tabular h-full w-full bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed"
      />
      {unit !== "£" ? <span className="ml-1 shrink-0 text-xs text-mist-400">{unit.replace("£", "")}</span> : null}
    </div>
  );
}

export function SettingsForm({
  initial,
  canEdit,
}: {
  initial: BusinessSettings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Record<keyof BusinessSettings, string>>({
    estimatorFee: String(initial.estimatorFee),
    costFuelPerMile: String(initial.costFuelPerMile),
    costLabourPerHour: String(initial.costLabourPerHour),
    costBox: String(initial.costBox),
    costVanDay: String(initial.costVanDay),
  });

  async function onSave() {
    setBusy(true);
    const payload = {
      estimatorFee: Number(v.estimatorFee),
      costFuelPerMile: Number(v.costFuelPerMile),
      costLabourPerHour: Number(v.costLabourPerHour),
      costBox: Number(v.costBox),
      costVanDay: Number(v.costVanDay),
    } satisfies SettingsInput;
    const res = await updateSettingsAction(payload);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not save.");
      return;
    }
    toast.success("Rates saved.");
    router.refresh();
  }

  return (
    <Card className="p-0">
      <div className="border-b px-5 py-3.5">
        <h2 className="font-display text-lg font-semibold text-foreground">Rates &amp; costs</h2>
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid gap-1.5">
            <Label htmlFor={`set-${f.key}`}>{f.label}</Label>
            <MoneyInput
              id={`set-${f.key}`}
              value={v[f.key]}
              unit={f.unit}
              disabled={!canEdit || busy}
              onChange={(val) => setV((s) => ({ ...s, [f.key]: val }))}
            />
            <p className="text-xs text-mist-400">{f.hint}</p>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="flex justify-end border-t px-5 py-4">
          <Button onClick={onSave} disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save rates
          </Button>
        </div>
      ) : (
        <div className="border-t px-5 py-3 text-xs text-mist-400">Only admins can change rates.</div>
      )}
    </Card>
  );
}
