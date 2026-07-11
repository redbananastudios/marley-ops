"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, LoaderCircle, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { finishAiRoomManuallyAction, ignoreFailedMediaAction, retryAiJobAction } from "@/app/actions/ai-survey-recovery";

export interface SurveyRoomState {
  id: string;
  name: string;
  status: string;
  itemCount: number;
  totalFt3: number;
  failedMediaId: string | null;
  retryJobId: string | null;
  manualFinishAvailable: boolean;
}

export function SurveyRoomsStrip({ leadId, rooms }: { leadId: string; rooms: SurveyRoomState[] }) {
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
      {rooms.map((room) => <article key={room.id} className="min-w-56 rounded-xl border border-border p-3">
        <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{room.name}</p><RoomStatus room={room} /></div>{room.status === "confirmed" && <CheckCircle2 className="size-5 text-success" />}{room.status === "processing" && <LoaderCircle className="size-5 animate-spin text-mm-red" />}{["failed", "needs_attention"].includes(room.status) && <CircleAlert className="size-5 text-warn" />}</div>
        {room.status === "ready" && <Link href={`/leads/${leadId}/cubic/review`} className="focus-ring mt-3 flex min-h-10 items-center justify-center rounded-lg bg-mm-red text-sm font-bold text-white">Review items</Link>}
        {(["failed", "needs_attention"].includes(room.status) || room.manualFinishAvailable) && <div className="mt-3 grid grid-cols-2 gap-2">
          {room.retryJobId && <button type="button" disabled={busy} onClick={() => run(() => retryAiJobAction(room.retryJobId!), "AI analysis queued again.")} className="focus-ring min-h-10 rounded-lg border border-border text-xs font-bold"><RotateCcw className="mr-1 inline size-3.5" /> Retry</button>}
          {room.failedMediaId && <button type="button" disabled={busy} onClick={() => run(() => ignoreFailedMediaAction(room.failedMediaId!), "Failed clip discarded.")} className="focus-ring min-h-10 rounded-lg border border-danger-border text-xs font-bold text-danger"><Trash2 className="mr-1 inline size-3.5" /> Discard</button>}
          {room.manualFinishAvailable && !room.failedMediaId && <button type="button" disabled={busy} onClick={() => run(() => finishAiRoomManuallyAction(room.id), "Room marked as manually completed.")} className="focus-ring col-span-2 min-h-10 rounded-lg border border-border text-xs font-bold">Finish manually</button>}
        </div>}
      </article>)}
      <Link href={`/leads/${leadId}/cubic/scan`} className="focus-ring grid min-h-24 min-w-36 place-items-center rounded-xl border border-dashed border-mm-red/40 text-sm font-bold text-mm-red"><span className="grid place-items-center"><Plus className="mb-1 size-5" /> Room</span></Link>
    </div>
  </section>;
}

function RoomStatus({ room }: { room: SurveyRoomState }) {
  const label = room.status === "processing" ? "Analysing…" : room.status === "ready" ? `Ready to review · ${room.itemCount} item${room.itemCount === 1 ? "" : "s"}` : room.status === "confirmed" ? `Confirmed · ${room.totalFt3.toFixed(0)} ft³` : room.status === "needs_attention" ? "Needs attention" : room.status === "failed" ? "Analysis failed" : room.status.replaceAll("_", " ");
  return <p className="mt-1 text-xs capitalize text-mist-400">{label}</p>;
}
