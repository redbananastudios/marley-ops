"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BrainCircuit, CheckCircle2, CircleAlert, Database } from "lucide-react";
import { toast } from "sonner";

import { updateAiSettingsAction } from "@/app/(dashboard)/settings/ai-actions";
import { retryAiJobAction } from "@/app/actions/ai-survey-recovery";
import { Card } from "@/components/ui/card";
import { AI_MODEL_IDS } from "@/lib/ai/budget";
import type { BusinessSettings } from "@/lib/settings";

interface ProblemJob {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
}

interface SpendMonth {
  month: string;
  spentUsd: number;
  reservedUsd: number;
  alertedAt: string | null;
}

interface AiSettingsCardProps {
  settings: BusinessSettings;
  spendHistory: SpendMonth[];
  mediaBytes: number;
  mediaCount: number;
  nextRetentionSweep: string;
  diskCapacityGb: number | null;
  configured: boolean;
  canEdit: boolean;
  problemJobs: ProblemJob[];
}

export function AiSettingsCard({
  settings,
  spendHistory,
  mediaBytes,
  mediaCount,
  nextRetentionSweep,
  diskCapacityGb,
  configured,
  canEdit,
  problemJobs,
}: AiSettingsCardProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.aiSurveyEnabled);
  const [grounded, setGrounded] = useState(settings.aiGroundedReplayEnabled);
  const [model, setModel] = useState(settings.aiModelDefault);
  const [escalation, setEscalation] = useState(settings.aiModelEscalation);
  const [surveyCap, setSurveyCap] = useState(String(settings.aiSurveyCapGbp));
  const [monthlyCap, setMonthlyCap] = useState(String(settings.aiMonthlyCapGbp));
  const [monthlyAlert, setMonthlyAlert] = useState(String(settings.aiMonthlyAlertGbp));
  const [busy, startTransition] = useTransition();
  const current = spendHistory.at(-1);
  const usedGb = mediaBytes / 1_073_741_824;
  const diskPercent = diskCapacityGb ? Math.min(100, (usedGb / diskCapacityGb) * 100) : null;

  function save() {
    startTransition(async () => {
      const result = await updateAiSettingsAction({
        enabled,
        groundedReplayEnabled: grounded,
        modelDefault: model,
        modelEscalation: escalation,
        surveyCapGbp: Number(surveyCap),
        monthlyCapGbp: Number(monthlyCap),
        monthlyAlertGbp: Number(monthlyAlert),
      });
      if (result.ok) toast.success("AI survey settings saved.");
      else toast.error(result.error);
    });
  }

  function recoverJob(job: ProblemJob) {
    startTransition(async () => {
      const result = await retryAiJobAction(job.id);
      if (result.ok) {
        toast.success(job.status === "blocked" ? "Spend controls cleared; job queued." : "AI job queued again.");
        router.refresh();
      } else toast.error(result.error);
    });
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-mm-red-tint text-mm-red-deep"><BrainCircuit className="size-5" /></span>
          <div><h2 className="font-display text-lg font-semibold">AI surveyor</h2><p className="text-xs text-mist-400">Estimator-only room inventory and volume assistance</p></div>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={!canEdit || !configured} className="size-5 accent-mm-red" /> Enabled</label>
      </div>

      <div className="grid gap-4 p-5 md:grid-cols-4">
        <Metric label="This month" value={`$${(current?.spentUsd ?? 0).toFixed(2)}`} detail={`$${(current?.reservedUsd ?? 0).toFixed(2)} reserved`} />
        <Metric label="Retained AI media" value={`${usedGb.toFixed(2)} GB`} detail={`${mediaCount} file${mediaCount === 1 ? "" : "s"} · next sweep ${new Date(nextRetentionSweep).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`} />
        <Metric label="Storage driver" value="Supabase" detail="Cloudflare R2 is the named scale target at 25 GB" />
        <div className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-semibold ${configured ? "border-success-border bg-success-bg text-success" : "border-warn-border bg-warn-bg text-warn"}`}>{configured ? <CheckCircle2 className="size-5" /> : <CircleAlert className="size-5" />}{configured ? "Provider and storage configured" : "Environment configuration incomplete"}</div>
      </div>

      {diskPercent !== null && <div className="border-t px-5 py-4"><div className="mb-2 flex justify-between text-xs font-semibold"><span className="flex items-center gap-1.5"><Database className="size-4" /> Media disk usage</span><span>{usedGb.toFixed(2)} / {diskCapacityGb?.toFixed(0)} GB</span></div><div className="h-2 overflow-hidden rounded-full bg-mist-100"><div className={`h-full rounded-full ${diskPercent >= 80 ? "bg-danger" : diskPercent >= 60 ? "bg-warn" : "bg-success"}`} style={{ width: `${diskPercent}%` }} /></div></div>}

      {!!spendHistory.length && <div className="border-t p-5"><h3 className="text-sm font-bold">Six-month spend history</h3><div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">{spendHistory.map((item) => <div key={item.month} className="rounded-lg border border-border p-3 text-sm"><p className="text-xs font-medium text-mist-400">{new Date(`${item.month}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</p><p className="mt-1 font-bold">${item.spentUsd.toFixed(2)}</p><p className="text-[11px] text-mist-400">${item.reservedUsd.toFixed(2)} reserved{item.alertedAt ? " · alerted" : ""}</p></div>)}</div></div>}

      <div className="grid gap-4 border-t p-5 md:grid-cols-2">
        <Field label="Default accuracy model"><select value={model} onChange={(event) => setModel(event.target.value as typeof model)} disabled={!canEdit || busy} className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-sm">{AI_MODEL_IDS.map((id) => <option key={id}>{id}</option>)}</select></Field>
        <Field label="Escalation model"><select value={escalation} onChange={(event) => setEscalation(event.target.value as typeof escalation)} disabled={!canEdit || busy} className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-sm">{AI_MODEL_IDS.map((id) => <option key={id}>{id}</option>)}</select></Field>
        {([["Per-survey cap (£)", surveyCap, setSurveyCap], ["Monthly cap (£)", monthlyCap, setMonthlyCap], ["Monthly alert (£)", monthlyAlert, setMonthlyAlert]] as const).map(([label, value, setter]) => <Field key={label} label={label}><input value={value} onChange={(event) => setter(event.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="focus-ring h-11 w-full rounded-lg border border-input bg-card px-3 text-base" disabled={!canEdit || busy} /></Field>)}
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={grounded} onChange={(event) => setGrounded(event.target.checked)} disabled={!canEdit || busy} className="size-5 accent-mm-red" /> Grounded image replay (experimental)</label>
      </div>

      {!!problemJobs.length && <div className="border-t p-5"><h3 className="text-sm font-bold">Jobs needing attention</h3><div className="mt-3 space-y-2">{problemJobs.map((job) => <div key={job.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div className="min-w-0"><p className="font-semibold capitalize">{job.status} · attempt {job.attempts}/{job.max_attempts}</p><p className="truncate text-xs text-mist-400">{job.error ?? "Waiting for its blocking condition to clear"}</p></div>{canEdit && <button type="button" disabled={busy} onClick={() => recoverJob(job)} className="focus-ring min-h-10 rounded-lg border border-border px-3 text-xs font-bold">{job.status === "blocked" ? "Recheck" : "Retry"}</button>}</div>)}</div></div>}
      {canEdit && <div className="border-t p-5"><button type="button" onClick={save} disabled={busy || !configured} className="focus-ring min-h-11 rounded-lg bg-mm-red px-5 text-sm font-semibold text-white disabled:opacity-40">Save AI settings</button></div>}
    </Card>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-border p-3"><p className="text-xs font-medium text-mist-400">{label}</p><p className="mt-1 font-display text-xl font-bold">{value}</p>{detail && <p className="mt-1 text-[11px] text-mist-400">{detail}</p>}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium">{label}{children}</label>;
}
