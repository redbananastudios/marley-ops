"use client";

/**
 * Settings › Storage rates (admin). The rate card new storage lets copy at
 * creation (docs/storage-billing-v2-prd.md §1). Customer figures are
 * VAT-INCLUSIVE (business_settings.storage_rates); supplier figures are GROSS
 * (FRS — no input VAT recovery, so the gross column is the real cost) and live
 * in the admin-only storage_supplier_rates singleton. Editing here never
 * touches a running let — the rate froze onto the let when it opened.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Warehouse } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveStorageRatesAction } from "@/app/(dashboard)/settings/actions";
import type { StorageRates } from "@/lib/storage-rates";
// Type-only import — erased at compile time, so no supplier VALUES enter the
// client bundle (lib/storage-supplier.ts is server-side only).
import type { StorageSupplierCosts } from "@/lib/storage-supplier";

type FieldKey =
  | "containerMonthInc"
  | "crateWeekInc"
  | "crateDayInc"
  | "crateMinDays"
  | "crateMinInc"
  | "handlingEventInc"
  | "supplierContainerMonthCost"
  | "supplierContainersCount"
  | "supplierCrateDayCost"
  | "supplierHandlingEventCost";

interface FieldDef {
  key: FieldKey;
  label: string;
  /** £ money field by default; "days"/"count" render a bare integer input. */
  kind?: "days" | "count";
  step?: string;
}

const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "containerMonthInc", label: "Container £/calendar month" },
  { key: "crateWeekInc", label: "Crate £/week" },
  { key: "crateDayInc", label: "Crate £/day" },
  { key: "crateMinDays", label: "Crate minimum days", kind: "days" },
  { key: "crateMinInc", label: "Crate minimum £" },
  { key: "handlingEventInc", label: "Handling £/event" },
];

const SUPPLIER_FIELDS: FieldDef[] = [
  { key: "supplierContainerMonthCost", label: "Container cost £/month" },
  { key: "supplierContainersCount", label: "Containers held", kind: "count" },
  { key: "supplierCrateDayCost", label: "Crate cost £/day", step: "0.0001" },
  { key: "supplierHandlingEventCost", label: "Handling cost £/event" },
];

function RateField({
  id,
  def,
  value,
  disabled,
  onChange,
}: {
  id: string;
  def: FieldDef;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const isMoney = !def.kind;
  return (
    <div className="flex h-11 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30 has-disabled:opacity-60">
      {isMoney ? <span className="mr-1 shrink-0 text-sm text-mist-400">£</span> : null}
      <input
        id={id}
        type="number"
        inputMode={isMoney ? "decimal" : "numeric"}
        min={def.kind === "days" ? 1 : 0}
        step={def.step ?? (isMoney ? "0.01" : "1")}
        value={value}
        disabled={disabled}
        // Every rate is required — a cleared field must not submit (the server
        // schema rejects "" too; this just fails fast in the browser).
        required
        onChange={(e) => onChange(e.target.value)}
        className="tabular h-full w-full bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed"
      />
      {def.kind === "days" ? <span className="ml-1 shrink-0 text-xs text-mist-400">days</span> : null}
    </div>
  );
}

export function StorageRatesCard({
  initial,
}: {
  initial: { customer: StorageRates; supplier: StorageSupplierCosts };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Record<FieldKey, string>>({
    containerMonthInc: String(initial.customer.containerMonthInc),
    crateWeekInc: String(initial.customer.crateWeekInc),
    crateDayInc: String(initial.customer.crateDayInc),
    crateMinDays: String(initial.customer.crateMinDays),
    crateMinInc: String(initial.customer.crateMinInc),
    handlingEventInc: String(initial.customer.handlingEventInc),
    supplierContainerMonthCost: String(initial.supplier.containerMonthCost),
    supplierContainersCount: String(initial.supplier.containersCount),
    supplierCrateDayCost: String(initial.supplier.crateDayCost),
    supplierHandlingEventCost: String(initial.supplier.handlingEventCost),
  });

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      // Raw field strings — the action's schema rejects "" before coercing, so
      // an empty field can never silently save as £0.
      const res = await saveStorageRatesAction({
        containerMonthInc: v.containerMonthInc,
        crateWeekInc: v.crateWeekInc,
        crateDayInc: v.crateDayInc,
        crateMinDays: v.crateMinDays,
        crateMinInc: v.crateMinInc,
        handlingEventInc: v.handlingEventInc,
        supplier: {
          containerMonthCost: v.supplierContainerMonthCost,
          containersCount: v.supplierContainersCount,
          crateDayCost: v.supplierCrateDayCost,
          handlingEventCost: v.supplierHandlingEventCost,
        },
      });
      if (!res.ok) {
        toast.error(res.error || "Could not save storage rates.");
        return;
      }
      toast.success("Storage rates saved.");
      router.refresh();
    } catch {
      toast.error("Something went wrong — check whether the change landed before retrying.");
    } finally {
      setBusy(false);
    }
  }

  const group = (title: string, hint: string, fields: FieldDef[]) => (
    <div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-mist-400">{hint}</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <div key={f.key} className="grid gap-1.5">
            <Label htmlFor={`storage-${f.key}`}>{f.label}</Label>
            <RateField
              id={`storage-${f.key}`}
              def={f}
              value={v[f.key]}
              disabled={busy}
              onChange={(val) => setV((s) => ({ ...s, [f.key]: val }))}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Card className="p-0">
      <form onSubmit={onSave}>
        <div className="flex items-center gap-3 border-b px-5 py-3.5">
          <Warehouse className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Storage rates</h2>
            <p className="mt-0.5 text-xs text-mist-400">
              What customers pay and what Sandys charges us. New lets copy these figures when they open.
            </p>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {group(
            "Customer rates (inc VAT)",
            "Containers bill per calendar month in advance; crates bill daily in arrears with a minimum stay.",
            CUSTOMER_FIELDS,
          )}
          {group(
            "Supplier costs (gross — FRS, no VAT recovery)",
            "Container cost accrues per container held, occupied or not. Crate + handling costs follow usage.",
            SUPPLIER_FIELDS,
          )}
          <p className="text-xs text-mist-400">
            New lets copy these rates at creation — running lets keep their frozen rate. The crate agreement
            wording renders the live handling figure, so a change here must be mirrored in the published terms.
          </p>
        </div>

        <div className="flex justify-end border-t px-5 py-4">
          <Button type="submit" disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save storage rates
          </Button>
        </div>
      </form>
    </Card>
  );
}
