"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, LoaderCircle, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { completeRoomManuallyAction, ignoreFailedMediaAction, retryAiJobAction } from "@/app/actions/ai-survey-recovery";
import { abandonAiSurveyAction, withdrawAiConsentAction } from "@/app/actions/ai-survey-privacy";
import { deleteRoomAction, updateRoomAction } from "@/app/actions/ai-survey";

export interface SurveyRoomState {
  id: string;
  name: string;
  status: string;
  roomType: string | null;
  floor: string | null;
  hiddenStorageChecked: boolean;
  itemCount: number;
  totalFt3: number;
  failedMediaId: string | null;
  retryJobId: string | null;
  manualFinishAvailable: boolean;
}

export function SurveyRoomsStrip({ surveyId, surveyUpdatedAt, leadId, rooms, canUseAi }: { surveyId: string; surveyUpdatedAt: string; leadId: string; rooms: SurveyRoomState[]; canUseAi: boolean }) {
  const [busy, startTransition] = useTransition();
  const router = useRouter();
  function run(task: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await task();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(result.error ?? "Could not update the room.");
    });
  }
  if (!rooms.length) return null;
  return <section className="mb-5 rounded-2xl border border-border bg-card p-3">
    <div className="flex gap-3 overflow-x-auto pb-1">
      {rooms.map((room) => <RoomCard key={room.id} room={room} surveyId={surveyId} surveyUpdatedAt={surveyUpdatedAt} leadId={leadId} busy={busy} canUseAi={canUseAi} run={run} />)}
      {canUseAi && <Link href={`/leads/${leadId}/cubic/scan`} className="focus-ring grid min-h-24 min-w-36 place-items-center rounded-xl border border-dashed border-mm-red/40 text-sm font-bold text-mm-red"><span className="grid place-items-center"><Plus className="mb-1 size-5" /> Room</span></Link>}
    </div>
    {canUseAi && <LifecycleControls surveyId={surveyId} busy={busy} run={run} />}
  </section>;
}

function RoomCard({ room, surveyId, surveyUpdatedAt, leadId, busy, canUseAi, run }: { room: SurveyRoomState; surveyId: string; surveyUpdatedAt: string; leadId: string; busy: boolean; canUseAi: boolean; run: (task: () => Promise<{ ok: boolean; error?: string }>, success: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(room.name);
  const [floor, setFloor] = useState(room.floor ?? "");
  const [hidden, setHidden] = useState(room.hiddenStorageChecked);
  if (editing) return <article className="min-w-72 rounded-xl border border-mm-red/30 bg-mm-red-tint/30 p-3"><p className="text-xs font-bold uppercase tracking-wide text-mm-red-deep">Edit room</p><input value={name} onChange={(event) => setName(event.target.value.slice(0, 60))} aria-label="Room name" className="focus-ring mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-base" /><input value={floor} onChange={(event) => setFloor(event.target.value.slice(0, 60))} placeholder="Floor (optional)" aria-label="Room floor" className="focus-ring mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-base" /><label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} className="size-5 accent-mm-red" /> Cupboards checked or narrated</label><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" disabled={busy || !name.trim()} onClick={() => run(() => updateRoomAction(room.id, { name, floor: floor || null, hiddenStorageChecked: hidden }), "Room updated.")} className="focus-ring min-h-11 rounded-lg bg-mm-red text-sm font-bold text-white">Save</button><button type="button" onClick={() => setEditing(false)} className="focus-ring min-h-11 rounded-lg border border-border text-sm font-bold">Cancel</button></div></article>;
  return <article className="min-w-56 rounded-xl border border-border p-3">
    <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{room.name}</p><RoomStatus room={room} /></div>{room.status === "confirmed" && <CheckCircle2 className="size-5 text-success" />}{room.status === "processing" && <LoaderCircle className="size-5 animate-spin text-mm-red" />}{["failed", "needs_attention", "blocked"].includes(room.status) && <CircleAlert className="size-5 text-warn" />}</div>
    {room.status === "ready" && <Link href={`/leads/${leadId}/cubic/review?room=${room.id}`} className="focus-ring mt-3 flex min-h-10 items-center justify-center rounded-lg bg-mm-red text-sm font-bold text-white">Review items</Link>}
    {canUseAi && (["failed", "needs_attention"].includes(room.status) || room.manualFinishAvailable) && <div className="mt-3 grid grid-cols-2 gap-2">{room.retryJobId && <button type="button" disabled={busy} onClick={() => run(() => retryAiJobAction(room.retryJobId!), "AI analysis queued again.")} className="focus-ring min-h-10 rounded-lg border border-border text-xs font-bold"><RotateCcw className="mr-1 inline size-3.5" /> Retry</button>}{room.failedMediaId && <button type="button" disabled={busy} onClick={() => run(() => ignoreFailedMediaAction(room.failedMediaId!), "Failed clip discarded.")} className="focus-ring min-h-10 rounded-lg border border-danger-border text-xs font-bold text-danger"><Trash2 className="mr-1 inline size-3.5" /> Discard</button>}{room.manualFinishAvailable && !room.failedMediaId && <button type="button" disabled={busy} onClick={() => run(() => completeRoomManuallyAction(surveyId, room.id, surveyUpdatedAt), "Room marked as manually completed.")} className="focus-ring col-span-2 min-h-10 rounded-lg border border-border text-xs font-bold">Finish manually</button>}</div>}
    {canUseAi && <div className="mt-2 flex gap-2"><button type="button" onClick={() => setEditing(true)} className="focus-ring min-h-9 flex-1 rounded-lg text-xs font-bold text-mist-500">Edit</button>{confirmDelete ? <button type="button" disabled={busy} onClick={() => run(() => deleteRoomAction(room.id), "Room deleted.")} className="focus-ring min-h-9 flex-1 rounded-lg bg-danger-bg text-xs font-bold text-danger">Confirm delete</button> : <button type="button" onClick={() => setConfirmDelete(true)} className="focus-ring min-h-9 flex-1 rounded-lg text-xs font-bold text-danger">Delete</button>}</div>}
  </article>;
}

function LifecycleControls({ surveyId, busy, run }: { surveyId: string; busy: boolean; run: (task: () => Promise<{ ok: boolean; error?: string }>, success: string) => void }) {
  const [mode, setMode] = useState<"none" | "stop" | "withdraw">("none");
  return <div className="mt-3 border-t border-border pt-3 text-right">{mode === "none" ? <div className="flex justify-end gap-2"><button type="button" onClick={() => setMode("stop")} className="focus-ring min-h-10 rounded-lg px-3 text-xs font-semibold text-mist-500">Stop using AI</button><button type="button" onClick={() => setMode("withdraw")} className="focus-ring min-h-10 rounded-lg px-3 text-xs font-semibold text-danger">Customer withdrew agreement</button></div> : <div className="inline-flex items-center gap-2 rounded-xl border border-danger-border bg-danger-bg p-2"><span className="max-w-64 text-left text-xs text-danger">{mode === "withdraw" ? "This immediately cancels queued analysis and schedules all footage for deletion." : "Unconfirmed AI work stops. Confirmed inventory remains editable."}</span><button type="button" disabled={busy} onClick={() => run(() => mode === "withdraw" ? withdrawAiConsentAction(surveyId) : abandonAiSurveyAction(surveyId), mode === "withdraw" ? "Agreement withdrawal recorded." : "AI assistance stopped.")} className="focus-ring min-h-10 rounded-lg bg-danger px-3 text-xs font-bold text-white">Confirm</button><button type="button" onClick={() => setMode("none")} className="focus-ring min-h-10 rounded-lg px-2 text-xs font-bold">Cancel</button></div>}</div>;
}

function RoomStatus({ room }: { room: SurveyRoomState }) {
  const label = room.status === "processing" ? "Analysing…" : room.status === "blocked" ? "AI paused by spend control" : room.status === "ready" ? `Ready to review · ${room.itemCount} item${room.itemCount === 1 ? "" : "s"}` : room.status === "confirmed" ? `Confirmed · ${room.totalFt3.toFixed(0)} ft³` : room.status === "needs_attention" ? "Needs attention" : room.status === "failed" ? "Analysis failed" : room.status.replaceAll("_", " ");
  return <p className="mt-1 text-xs capitalize text-mist-400">{label}</p>;
}
