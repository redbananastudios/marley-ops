"use client";

import { useState, useTransition } from "react";
import { BrainCircuit, CheckCircle2, CircleAlert } from "lucide-react";
import { toast } from "sonner";

import { updateAiSettingsAction } from "@/app/(dashboard)/settings/ai-actions";
import { Card } from "@/components/ui/card";
import { AI_MODEL_IDS } from "@/lib/ai/budget";
import type { BusinessSettings } from "@/lib/settings";

export function AiSettingsCard({ settings, spentUsd, mediaBytes, configured, canEdit }: { settings: BusinessSettings; spentUsd: number; mediaBytes: number; configured: boolean; canEdit: boolean }) {
  const [enabled, setEnabled] = useState(settings.aiSurveyEnabled);
  const [grounded, setGrounded] = useState(settings.aiGroundedReplayEnabled);
  const [model, setModel] = useState(settings.aiModelDefault);
  const [escalation, setEscalation] = useState(settings.aiModelEscalation);
  const [surveyCap, setSurveyCap] = useState(String(settings.aiSurveyCapGbp));
  const [monthlyCap, setMonthlyCap] = useState(String(settings.aiMonthlyCapGbp));
  const [monthlyAlert, setMonthlyAlert] = useState(String(settings.aiMonthlyAlertGbp));
  const [busy, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await updateAiSettingsAction({ enabled, groundedReplayEnabled: grounded, modelDefault: model, modelEscalation: escalation, surveyCapGbp: Number(surveyCap), monthlyCapGbp: Number(monthlyCap), monthlyAlertGbp: Number(monthlyAlert) });
      if (result.ok) toast.success("AI survey settings saved.");
      else toast.error(result.error);
    });
  }

  return <Card className="overflow-hidden p-0">
    <div className="flex items-center justify-between border-b px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-mm-red-tint text-mm-red-deep"><BrainCircuit className="size-5" /></span><div><h2 className="font-display text-lg font-semibold">AI surveyor</h2><p className="text-xs text-mist-400">Estimator-only room inventory and volume assistance</p></div></div><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={!canEdit || !configured} className="size-5 accent-mm-red" /> Enabled</label></div>
    <div className="grid gap-4 p-5 md:grid-cols-3"><Metric label="This month" value={`$${spentUsd.toFixed(2)}`} /><Metric label="Retained AI media" value={`${(mediaBytes / 1_073_741_824).toFixed(2)} GB`} /><div className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-semibold ${configured ? "border-success-border bg-success-bg text-success" : "border-warn-border bg-warn-bg text-warn"}`}>{configured ? <CheckCircle2 className="size-5" /> : <CircleAlert className="size-5" />}{configured ? "Provider and storage configured" : "Environment configuration incomplete"}</div></div>
    <div className="grid gap-4 border-t p-5 md:grid-cols-2"><Field label="Default accuracy model"><select value={model} onChange={(event) => setModel(event.target.value as typeof model)} disabled={!canEdit || busy} className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-sm">{AI_MODEL_IDS.map((id) => <option key={id}>{id}</option>)}</select></Field><Field label="Escalation model"><select value={escalation} onChange={(event) => setEscalation(event.target.value as typeof escalation)} disabled={!canEdit || busy} className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-sm">{AI_MODEL_IDS.map((id) => <option key={id}>{id}</option>)}</select></Field>{([[
      "Per-survey cap (£)", surveyCap, setSurveyCap,
    ], ["Monthly cap (£)", monthlyCap, setMonthlyCap], ["Monthly alert (£)", monthlyAlert, setMonthlyAlert]] as const).map(([label, value, setter]) => <Field key={label} label={label}><input value={value} onChange={(event) => setter(event.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-base" disabled={!canEdit || busy} /></Field>)}<label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={grounded} onChange={(event) => setGrounded(event.target.checked)} disabled={!canEdit || busy} className="size-5 accent-mm-red" /> Grounded image replay (experimental)</label></div>
    {canEdit && <div className="border-t p-5"><button type="button" onClick={save} disabled={busy || !configured} className="focus-ring min-h-11 rounded-lg bg-mm-red px-5 text-sm font-semibold text-white disabled:opacity-40">Save AI settings</button></div>}
  </Card>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-border p-3"><p className="text-xs font-medium text-mist-400">{label}</p><p className="mt-1 font-display text-xl font-bold">{value}</p></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5 text-sm font-medium">{label}{children}</label>; }
