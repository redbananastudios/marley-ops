"use client";

/**
 * Margin calculator — a what-if sandbox. Pick a job shape (vans, 7.5t, packing,
 * miles, men, hours, boxes, days), and see what the customer is charged vs what it
 * costs vs the margin. Charges run through the real quote engine (computeQuote with
 * an editable price config), so the numbers match live quotes; costs come from the
 * editable rate card. Nothing here touches live quotes or saved settings — it's a
 * model. Charge prices + cost rates are inline-editable so you can try scenarios.
 */

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { computeQuote, DEFAULT_PRICING, type PricingConfig } from "@/lib/quote/pricing";
import type { PackingKey, VehicleKey } from "@/lib/quote/constants";
import type { BusinessSettings } from "@/lib/settings";

const gbp = (n: number): string =>
  (n < 0 ? "-£" : "£") + Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 });

interface Job {
  vehicle: VehicleKey;
  has75T: boolean;
  packing: PackingKey;
  miles: number;
  men: number;
  hours: number;
  boxes: number;
  days: number;
  congestion: boolean;
}

const PRESETS: { label: string; job: Job }[] = [
  { label: "2-bed local", job: { vehicle: "1luton", has75T: false, packing: "owner", miles: 20, men: 2, hours: 6, boxes: 25, days: 1, congestion: false } },
  { label: "3-bed · 50mi", job: { vehicle: "2luton", has75T: false, packing: "fragile", miles: 110, men: 3, hours: 8, boxes: 40, days: 1, congestion: false } },
  { label: "4-bed long distance", job: { vehicle: "3luton", has75T: false, packing: "full", miles: 420, men: 4, hours: 10, boxes: 60, days: 2, congestion: false } },
];

const numCls =
  "tabular h-9 w-full rounded-md border border-input bg-card px-2 text-sm text-foreground focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/30";

function NumIn({ value, onChange, step = 1 }: { value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      className={numCls}
    />
  );
}

/** A breakdown line: label, an optional editable rate, and the computed amount. */
function Line({
  label,
  rate,
  onRate,
  rateUnit,
  amount,
  strong,
}: {
  label: string;
  rate?: number;
  onRate?: (n: number) => void;
  rateUnit?: string;
  amount: number;
  strong?: boolean;
}) {
  return (
    <div className={"flex items-center gap-3 py-1.5 " + (strong ? "border-t pt-2 font-semibold" : "")}>
      <span className={"flex-1 text-sm " + (strong ? "text-foreground" : "text-mist-500")}>{label}</span>
      {onRate ? (
        <span className="flex items-center gap-1">
          <span className="text-xs text-mist-400">£</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={rate ?? 0}
            onChange={(e) => onRate(e.target.value === "" ? 0 : Number(e.target.value))}
            className="tabular h-8 w-20 rounded-md border border-input bg-card px-2 text-sm text-foreground focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/30"
          />
          {rateUnit ? <span className="text-xs text-mist-400">{rateUnit}</span> : null}
        </span>
      ) : null}
      <span className="tabular w-20 text-right text-sm text-foreground">{gbp(amount)}</span>
    </div>
  );
}

export function MarginCalculator({ settings }: { settings: BusinessSettings }) {
  const [job, setJob] = useState<Job>(PRESETS[0].job);

  // Editable charge levers (seed from the locked defaults; reset when tier/packing change).
  const [base, setBase] = useState(DEFAULT_PRICING.base[job.vehicle]);
  const [packPrice, setPackPrice] = useState(DEFAULT_PRICING.pack[job.vehicle][job.packing]);
  const [addon75Base, setAddon75Base] = useState(DEFAULT_PRICING.addon75Base);
  const [addon75Pack, setAddon75Pack] = useState(DEFAULT_PRICING.addon75Pack[job.packing]);
  const [mileageRate, setMileageRate] = useState(DEFAULT_PRICING.mileageRate);
  const [adminFee, setAdminFee] = useState(DEFAULT_PRICING.adminFee);
  const [congestionPerVan, setCongestionPerVan] = useState(DEFAULT_PRICING.congestionPerVan);

  useEffect(() => {
    setBase(DEFAULT_PRICING.base[job.vehicle]);
    setPackPrice(DEFAULT_PRICING.pack[job.vehicle][job.packing]);
    setAddon75Pack(DEFAULT_PRICING.addon75Pack[job.packing]);
  }, [job.vehicle, job.packing]);

  // Editable cost rates (seed from the saved rate card).
  const [labour, setLabour] = useState(settings.costLabourPerHour);
  const [vanDay, setVanDay] = useState(settings.costVanDay);
  const [fuel, setFuel] = useState(settings.costFuelPerMile);
  const [boxCost, setBoxCost] = useState(settings.costBox);
  const [misc, setMisc] = useState(settings.costMisc);
  const [estFee, setEstFee] = useState(settings.estimatorFee);

  const setJ = <K extends keyof Job>(k: K, v: Job[K]) => setJob((j) => ({ ...j, [k]: v }));

  // Charge via the real engine with the (possibly edited) price config.
  const breakdown = useMemo(() => {
    const pricing: PricingConfig = {
      ...DEFAULT_PRICING,
      base: { ...DEFAULT_PRICING.base, [job.vehicle]: base },
      pack: {
        ...DEFAULT_PRICING.pack,
        [job.vehicle]: { ...DEFAULT_PRICING.pack[job.vehicle], [job.packing]: packPrice },
      },
      addon75Base,
      addon75Pack: { ...DEFAULT_PRICING.addon75Pack, [job.packing]: addon75Pack },
      mileageRate,
      adminFee,
      congestionPerVan,
    };
    return computeQuote(
      {
        vehicle: job.vehicle,
        packing: job.packing,
        has75T: job.has75T,
        deadMiles: 0,
        jobMiles: job.miles,
        collectAccessM: 0,
        destAccessM: 0,
        collectType: "house",
        collectFloor: "ground",
        destType: "house",
        destFloor: "ground",
        congestion: job.congestion,
        tolls: 0,
        parking: 0,
        discount: 0,
        vatEnabled: false,
      },
      pricing,
    );
  }, [job, base, packPrice, addon75Base, addon75Pack, mileageRate, adminFee, congestionPerVan]);

  const charge = breakdown.total; // ex-VAT (VAT is pass-through, not margin)
  const vanCount = breakdown.vanCount;

  const cost = useMemo(() => {
    const labourCost = job.men * job.hours * labour;
    const vansCost = vanCount * job.days * vanDay;
    const fuelCost = job.miles * fuel;
    const boxesCost = job.boxes * boxCost;
    const total = labourCost + vansCost + fuelCost + boxesCost + misc + estFee;
    return { labourCost, vansCost, fuelCost, boxesCost, misc, estFee, total };
  }, [job, vanCount, labour, vanDay, fuel, boxCost, misc, estFee]);

  const margin = charge - cost.total;
  const marginPct = charge > 0 ? Math.round((margin / charge) * 100) : 0;
  const marginTone = margin < 0 ? "text-danger" : marginPct < 25 ? "text-warn" : "text-success";

  return (
    <Card className="p-0">
      <div className="border-b px-5 py-3.5">
        <h2 className="font-display text-lg font-semibold text-foreground">Margin calculator</h2>
        <p className="mt-0.5 text-xs text-mist-400">
          A what-if model. Charges run through the real quote engine; costs use your rate card. Nothing here changes
          live quotes or saved settings.
        </p>
      </div>

      {/* presets */}
      <div className="flex flex-wrap gap-2 border-b px-5 py-3">
        <span className="self-center text-xs text-mist-400">Try:</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setJob(p.job)}
            className="focus-ring rounded-pill border border-border bg-card px-3 py-1 text-xs font-medium text-mist-600 hover:bg-muted"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* the job */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b px-5 py-4 sm:grid-cols-3 lg:grid-cols-4">
        <label className="grid gap-1">
          <span className="eyebrow">Vans</span>
          <Select value={job.vehicle} onValueChange={(v) => setJ("vehicle", v as VehicleKey)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1luton">1 Luton</SelectItem>
              <SelectItem value="2luton">2 Luton</SelectItem>
              <SelectItem value="3luton">3 Luton</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1">
          <span className="eyebrow">Packing</span>
          <Select value={job.packing} onValueChange={(v) => setJ("packing", v as PackingKey)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="owner">Owner packs</SelectItem>
              <SelectItem value="fragile">Fragile only</SelectItem>
              <SelectItem value="full">Full pack</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1"><span className="eyebrow">Miles (total)</span><NumIn value={job.miles} onChange={(n) => setJ("miles", n)} /></label>
        <label className="grid gap-1"><span className="eyebrow">Days</span><NumIn value={job.days} onChange={(n) => setJ("days", n)} /></label>
        <label className="grid gap-1"><span className="eyebrow">Men</span><NumIn value={job.men} onChange={(n) => setJ("men", n)} /></label>
        <label className="grid gap-1"><span className="eyebrow">Hours</span><NumIn value={job.hours} onChange={(n) => setJ("hours", n)} /></label>
        <label className="grid gap-1"><span className="eyebrow">Boxes</span><NumIn value={job.boxes} onChange={(n) => setJ("boxes", n)} /></label>
        <div className="flex items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={job.has75T} onChange={(e) => setJ("has75T", e.target.checked)} className="size-4 accent-mm-red" />
            7.5t
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={job.congestion} onChange={(e) => setJ("congestion", e.target.checked)} className="size-4 accent-mm-red" />
            Congestion
          </label>
        </div>
      </div>

      {/* charge vs cost */}
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
        <div>
          <p className="eyebrow mb-1">Customer charged <span className="font-normal normal-case text-mist-400">(ex VAT · editable rates)</span></p>
          <Line label={`Base (${vanCount} van${vanCount === 1 ? "" : "s"})`} rate={base} onRate={setBase} amount={breakdown.base} />
          <Line label="Packing" rate={packPrice} onRate={setPackPrice} amount={breakdown.packCost} />
          {job.has75T ? <Line label="7.5t add-on" rate={addon75Base} onRate={setAddon75Base} amount={breakdown.addon75Cost} /> : null}
          {job.has75T ? <Line label="7.5t packing" rate={addon75Pack} onRate={setAddon75Pack} amount={breakdown.addon75PackCost} /> : null}
          <Line label={`Mileage (${job.miles}mi)`} rate={mileageRate} onRate={setMileageRate} rateUnit="/mi" amount={breakdown.mileageCost ?? 0} />
          {job.congestion ? <Line label="Congestion" rate={congestionPerVan} onRate={setCongestionPerVan} rateUnit="/van" amount={breakdown.congestion} /> : null}
          <Line label="Admin fee" rate={adminFee} onRate={setAdminFee} amount={breakdown.adminFee} />
          <Line label="Charge (ex VAT)" amount={charge} strong />
        </div>

        <div>
          <p className="eyebrow mb-1">Your cost <span className="font-normal normal-case text-mist-400">(editable rates)</span></p>
          <Line label={`Labour (${job.men}×${job.hours}h)`} rate={labour} onRate={setLabour} rateUnit="/h" amount={cost.labourCost} />
          <Line label={`Vans (${vanCount}×${job.days}d)`} rate={vanDay} onRate={setVanDay} rateUnit="/d" amount={cost.vansCost} />
          <Line label={`Fuel (${job.miles}mi)`} rate={fuel} onRate={setFuel} rateUnit="/mi" amount={cost.fuelCost} />
          <Line label={`Boxes (${job.boxes})`} rate={boxCost} onRate={setBoxCost} amount={cost.boxesCost} />
          <Line label="Misc / consumables" rate={misc} onRate={setMisc} amount={cost.misc} />
          <Line label="Estimator fee (survey)" rate={estFee} onRate={setEstFee} amount={cost.estFee} />
          <Line label="Total cost" amount={cost.total} strong />
        </div>
      </div>

      {/* margin */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t bg-muted/40 px-5 py-4">
        <div>
          <p className="eyebrow">Margin per job</p>
          <p className={"font-display text-3xl font-bold " + marginTone}>{gbp(margin)}</p>
        </div>
        <div className="text-right">
          <p className="eyebrow">Margin %</p>
          <p className={"font-display text-3xl font-bold " + marginTone}>{marginPct}%</p>
        </div>
      </div>
    </Card>
  );
}
