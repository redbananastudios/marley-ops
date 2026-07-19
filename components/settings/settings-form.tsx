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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateSettingsAction, type SettingsInput } from "@/app/(dashboard)/settings/actions";
import type { BusinessSettings } from "@/lib/settings";

interface FieldDef {
  key: RateSettingKey;
  label: string;
  hint: string;
  unit: "£" | "£/mile" | "£/hour" | "£/day";
}

type RateSettingKey = Exclude<
  keyof BusinessSettings,
  | "vatDefault"
  | "vatNumber"
  | "vatStaggerGroup"
  | "vatScheme"
  | "vatFlatRatePct"
  | "estimatorCommissionPct"
  | "baseLocation"
  | "googleReviewUrl"
  | "aiSurveyEnabled"
  | "aiGroundedReplayEnabled"
  | "aiModelDefault"
  | "aiModelEscalation"
  | "aiSurveyCapGbp"
  | "aiMonthlyCapGbp"
  | "aiMonthlyAlertGbp"
>;

const FIELDS: FieldDef[] = [
  { key: "estimatorFee", label: "Estimator fee per visit", hint: "Paid per attended survey. Drives Performance + the estimator's invoice.", unit: "£" },
  { key: "estimatorPhoneQuoteFee", label: "Estimator phone-quote fee", hint: "Paid per telephone quote where the estimator doesn't attend a survey.", unit: "£" },
  { key: "costFuelPerMile", label: "Luton fuel cost per mile", hint: "Per mile, per Luton van. Fuel scales with vans.", unit: "£/mile" },
  { key: "costFuel75PerMile", label: "7.5t fuel cost per mile", hint: "Per mile, per 7.5t lorry.", unit: "£/mile" },
  { key: "costLabourPerDay", label: "Labour day rate (per man)", hint: "Per man per day. Bills the full crew: vans + 1, plus each 7.5t's crew.", unit: "£/day" },
  { key: "costBox", label: "Box unit cost", hint: "Per box supplied. Internal cost.", unit: "£" },
  { key: "costVanDay", label: "Luton van day rate", hint: "Per Luton vehicle per day (crew billed via labour).", unit: "£/day" },
  { key: "costTransitDay", label: "Transit van day rate", hint: "Per Transit vehicle per day (its man billed via labour).", unit: "£/day" },
  { key: "cost75t", label: "7.5t lorry (per lorry)", hint: "Flat per 7.5t lorry — vehicle only. Its crew is billed via labour.", unit: "£" },
  { key: "costMisc", label: "Misc / consumables", hint: "Tape, wrap, sundries per job. Internal cost.", unit: "£" },
  { key: "defaultDeposit", label: "Standard deposit", hint: "Prefills 'Request deposit' on a job. Editable per job.", unit: "£" },
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
  const [vatDefault, setVatDefault] = useState(initial.vatDefault);
  const [vatNumber, setVatNumber] = useState(initial.vatNumber);
  const [vatStaggerGroup, setVatStaggerGroup] = useState(String(initial.vatStaggerGroup));
  const [vatScheme, setVatScheme] = useState<"standard" | "flat_rate">(initial.vatScheme);
  const [vatFlatRatePct, setVatFlatRatePct] = useState(String(initial.vatFlatRatePct));
  const [baseLocation, setBaseLocation] = useState(initial.baseLocation);
  const [googleReviewUrl, setGoogleReviewUrl] = useState(initial.googleReviewUrl);
  const [estimatorCommissionPct, setEstimatorCommissionPct] = useState(String(initial.estimatorCommissionPct));
  const [v, setV] = useState<Record<RateSettingKey, string>>({
    estimatorFee: String(initial.estimatorFee),
    estimatorPhoneQuoteFee: String(initial.estimatorPhoneQuoteFee),
    costFuelPerMile: String(initial.costFuelPerMile),
    costFuel75PerMile: String(initial.costFuel75PerMile),
    costLabourPerDay: String(initial.costLabourPerDay),
    costBox: String(initial.costBox),
    costVanDay: String(initial.costVanDay),
    costTransitDay: String(initial.costTransitDay),
    cost75t: String(initial.cost75t),
    costMisc: String(initial.costMisc),
    defaultDeposit: String(initial.defaultDeposit),
    cubicFillPct: String(initial.cubicFillPct),
    cubicTransitFt3: String(initial.cubicTransitFt3),
    cubicLutonFt3: String(initial.cubicLutonFt3),
    cubic75tFt3: String(initial.cubic75tFt3),
  });

  async function onSave() {
    setBusy(true);
    const payload = {
      estimatorFee: Number(v.estimatorFee),
      estimatorPhoneQuoteFee: Number(v.estimatorPhoneQuoteFee),
      estimatorCommissionPct: Number(estimatorCommissionPct),
      costFuelPerMile: Number(v.costFuelPerMile),
      costFuel75PerMile: Number(v.costFuel75PerMile),
      costLabourPerDay: Number(v.costLabourPerDay),
      costBox: Number(v.costBox),
      costVanDay: Number(v.costVanDay),
      costTransitDay: Number(v.costTransitDay),
      cost75t: Number(v.cost75t),
      costMisc: Number(v.costMisc),
      defaultDeposit: Number(v.defaultDeposit),
      vatDefault,
      vatNumber: vatNumber.trim(),
      vatStaggerGroup: Number(vatStaggerGroup),
      vatScheme,
      vatFlatRatePct: Number(vatFlatRatePct),
      baseLocation: baseLocation.trim(),
      googleReviewUrl: googleReviewUrl.trim(),
      cubicFillPct: Number(v.cubicFillPct),
      cubicTransitFt3: Number(v.cubicTransitFt3),
      cubicLutonFt3: Number(v.cubicLutonFt3),
      cubic75tFt3: Number(v.cubic75tFt3),
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

      {/* Estimator completion commission — % of the ex-VAT job value, on completion */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-estimator-commission">Estimator completion commission</Label>
        <div className="mt-1.5 flex h-11 w-40 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30 has-disabled:opacity-60">
          <input
            id="set-estimator-commission"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.5"
            value={estimatorCommissionPct}
            disabled={!canEdit || busy}
            onChange={(e) => setEstimatorCommissionPct(e.target.value)}
            className="tabular h-full w-full bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed"
          />
          <span className="ml-1 shrink-0 text-sm text-mist-400">%</span>
        </div>
        <p className="mt-1.5 text-xs text-mist-400">
          Paid to the estimator on a job&apos;s completion, as a % of the ex-VAT job value (Luke = 7.5%). Appears on their weekly
          invoice for jobs that completed that week.
        </p>
      </div>

      {/* Cubic survey van planning — feeds the volume→van recommendation */}
      <div className="border-t px-5 py-4">
        <p className="text-sm font-medium text-foreground">Cubic survey — van planning</p>
        <p className="mt-0.5 text-xs text-mist-400">
          Usable load volume per vehicle and the fill level crews realistically pack to. Drives the van
          recommendation on surveys and new quotes.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          {(
            [
              ["cubicLutonFt3", "Luton (ft³)"],
              ["cubicTransitFt3", "Transit (ft³)"],
              ["cubic75tFt3", "7.5t (ft³)"],
              ["cubicFillPct", "Planning fill %"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`set-${key}`}>{label}</Label>
              <input
                id={`set-${key}`}
                type="number"
                inputMode="decimal"
                min={key === "cubicFillPct" ? 50 : 1}
                max={key === "cubicFillPct" ? 100 : 10000}
                value={v[key]}
                disabled={!canEdit || busy}
                onChange={(e) => setV((s) => ({ ...s, [key]: e.target.value }))}
                className="tabular flex h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:border-mm-red focus:ring-2 focus:ring-mm-red/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Base / yard location */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-base-location">Base / yard location</Label>
        <input
          id="set-base-location"
          type="text"
          value={baseLocation}
          disabled={!canEdit || busy}
          onChange={(e) => setBaseLocation(e.target.value)}
          placeholder="Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX"
          className="mt-1.5 flex h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:border-mm-red focus:ring-2 focus:ring-mm-red/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-1.5 text-xs text-mist-400">
          The yard mileage starts from, and the origin for the &quot;route from base&quot; map on a client.
        </p>
      </div>

      {/* VAT registration number — printed on quote PDFs (legal requirement) */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-vat-number">VAT registration number</Label>
        <input
          id="set-vat-number"
          type="text"
          value={vatNumber}
          disabled={!canEdit || busy}
          onChange={(e) => setVatNumber(e.target.value)}
          placeholder="e.g. GB 123 4567 89"
          className="mt-1.5 flex h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:border-mm-red focus:ring-2 focus:ring-mm-red/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-1.5 text-xs text-mist-400">Printed in the quote PDF footer. Required on customer paperwork once VAT registered.</p>
      </div>

      {/* VAT scheme — drives Finance's "owed to HMRC" figures. Invoices always
          charge 20%; the Flat Rate Scheme only changes the liability calc. */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-vat-scheme">VAT scheme</Label>
        <div className="mt-1.5 grid gap-3 sm:grid-cols-[1fr_140px]">
          <Select
            value={vatScheme}
            onValueChange={(v) => setVatScheme(v as "standard" | "flat_rate")}
            disabled={!canEdit || busy}
          >
            <SelectTrigger id="set-vat-scheme" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="flat_rate">Flat Rate Scheme (owe % of gross turnover)</SelectItem>
              <SelectItem value="standard">Standard (owe the 20% charged)</SelectItem>
            </SelectContent>
          </Select>
          {vatScheme === "flat_rate" ? (
            <div className="flex h-11 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
              <input
                id="set-vat-flat-rate"
                type="number"
                inputMode="decimal"
                min={1}
                max={16.5}
                step="0.5"
                value={vatFlatRatePct}
                disabled={!canEdit || busy}
                onChange={(e) => setVatFlatRatePct(e.target.value)}
                aria-label="Flat rate percentage"
                className="tabular h-full w-full bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed"
              />
              <span className="ml-1 shrink-0 text-sm text-mist-400">%</span>
            </div>
          ) : null}
        </div>
        <p className="mt-1.5 text-xs text-mist-400">
          Customers are charged 20% either way — this only changes what&apos;s OWED to HMRC on Finance.
          Removals/transport FRS rate is 10%; a first-year discount may make it 9% until 31 May 2027 —
          confirm the rate with the accountant.
        </p>
      </div>

      {/* VAT quarter cycle — drives Finance's quarter-to-date VAT rollup */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-vat-stagger">VAT quarter cycle</Label>
        <Select value={vatStaggerGroup} onValueChange={setVatStaggerGroup} disabled={!canEdit || busy}>
          <SelectTrigger id="set-vat-stagger" className="mt-1.5 h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Quarters ending Mar / Jun / Sep / Dec</SelectItem>
            <SelectItem value="2">Quarters ending Apr / Jul / Oct / Jan</SelectItem>
            <SelectItem value="3">Quarters ending May / Aug / Nov / Feb</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-mist-400">
          The return periods HMRC assigned on VAT registration (the &quot;stagger&quot;) — it&apos;s on the VAT
          certificate or any past return. Drives the quarter-to-date VAT figure on Finance → Invoices &amp; VAT.
        </p>
      </div>

      {/* Google review link — the post-move review email sends only when set */}
      <div className="border-t px-5 py-4">
        <Label htmlFor="set-review-url">Google review link</Label>
        <input
          id="set-review-url"
          type="url"
          value={googleReviewUrl}
          disabled={!canEdit || busy}
          onChange={(e) => setGoogleReviewUrl(e.target.value)}
          placeholder="https://search.google.com/local/writereview?placeid=…"
          className="mt-1.5 flex h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:border-mm-red focus:ring-2 focus:ring-mm-red/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p className="mt-1.5 text-xs text-mist-400">
          The &quot;leave a review&quot; button in the post-move email. Clear it to switch the review ask off.
        </p>
      </div>

      {/* VAT default for new quotes */}
      <div className="flex items-center justify-between gap-4 border-t px-5 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Quotes charge VAT (20%)</p>
          <p className="text-xs text-mist-400">Applied to every new quote — VAT is set here, not per quote.</p>
        </div>
        <label className="relative inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            role="switch"
            aria-label="New quotes default to VAT"
            className="peer sr-only"
            checked={vatDefault}
            disabled={!canEdit || busy}
            onChange={(e) => setVatDefault(e.target.checked)}
          />
          <span className="h-7 w-12 rounded-full bg-mist-200 transition-colors peer-checked:bg-mm-red peer-disabled:opacity-60" />
          <span className="absolute left-1 size-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
        </label>
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
