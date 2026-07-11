"use client";
/* eslint-disable @next/next/no-img-element -- signed private evidence URLs are not optimiser inputs */

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, ChevronRight, Play, ScanLine, X } from "lucide-react";
import { toast } from "sonner";

import {
  acceptRoomDetectionsAction,
  confirmAiItemsAction,
  resolveDetectionAction,
  setRoomManifestCompleteAction,
} from "@/app/actions/ai-survey-review";
import { cn } from "@/lib/utils";

export interface ReviewRoom { id: string; name: string; status: string; coverage: string | null }
export interface ReviewMedia { id: string; roomId: string | null; kind: string; url: string }
export interface ReviewDetection {
  id: string; roomId: string | null; label: string; catalogueKey: string | null;
  candidates: { key: string; confidence: number }[]; qty: number; confidence: number;
  moving: string; flags: { dismantle?: boolean; fragile?: boolean }; evidence: { kind?: string; timestampsS?: number[]; box2d?: number[] };
  reviewReason: string | null; state: string;
}
export interface CatalogueOption { key: string; title: string; ft3: number; category: string }

export function ReviewWorkspace({ surveyId, leadId, initialUpdatedAt, manifestComplete, rooms, media, detections, catalogue }: {
  surveyId: string; leadId: string; initialUpdatedAt: string; manifestComplete: boolean;
  rooms: ReviewRoom[]; media: ReviewMedia[]; detections: ReviewDetection[]; catalogue: CatalogueOption[];
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeRoomId, setActiveRoomId] = useState(rooms[0]?.id ?? "");
  const [items, setItems] = useState(detections);
  const [manifest, setManifest] = useState(manifestComplete);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [busy, startTransition] = useTransition();
  const activeRoom = rooms.find((room) => room.id === activeRoomId);
  const roomItems = items.filter((item) => item.roomId === activeRoomId);
  const activeMedia = media.find((item) => item.roomId === activeRoomId);
  const unresolved = roomItems.filter((item) => item.state === "proposed").length;
  const catalogueByKey = useMemo(() => new Map(catalogue.map((item) => [item.key, item])), [catalogue]);

  function mutate<T extends { ok: boolean; error?: string }>(task: () => Promise<T>, onSuccess: (result: T) => void) {
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        toast.error(result.error ?? "Could not save the review.");
        return;
      }
      onSuccess(result);
    });
  }

  function review(id: string, state: "accepted" | "rejected", resolution?: Parameters<typeof resolveDetectionAction>[1]["resolution"]) {
    mutate(() => resolveDetectionAction(id, { state: resolution ? "edited" : state, resolution }), () => {
      setItems((current) => current.map((item) => item.id === id ? { ...item, state: resolution ? "edited" : state } : item));
    });
  }

  function seek(seconds: number) {
    if (!videoRef.current) return;
    videoRef.current.currentTime = seconds;
    void videoRef.current.play();
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)_420px]">
      <aside className="rounded-2xl border border-border bg-card p-3">
        <p className="px-2 py-2 text-xs font-bold uppercase tracking-[0.18em] text-mist-400">Room by room</p>
        <div className="space-y-2">{rooms.map((room) => {
          const count = items.filter((item) => item.roomId === room.id && item.state !== "rejected").length;
          return <button key={room.id} type="button" onClick={() => setActiveRoomId(room.id)} className={cn("focus-ring flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left", room.id === activeRoomId ? "border-mm-red bg-mm-red-tint" : "border-border")}><span><span className="block text-sm font-semibold">{room.name}</span><span className="text-xs text-mist-400">{count} items · {room.status.replace("_", " ")}</span></span><ChevronRight className="size-4 text-mist-400" /></button>;
        })}</div>
        <label className="mt-4 flex min-h-12 items-start gap-3 rounded-xl border border-border p-3 text-sm"><input type="checkbox" checked={manifest} onChange={(event) => { const checked = event.target.checked; mutate(() => setRoomManifestCompleteAction(surveyId, checked), () => setManifest(checked)); }} className="mt-0.5 size-5 accent-mm-red" /><span><strong>All rooms listed</strong><span className="mt-1 block text-xs text-mist-400">Required before final totals.</span></span></label>
        <Link href={`/leads/${leadId}/cubic/scan`} className="focus-ring mt-3 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold"><ScanLine className="size-4" /> Capture another room</Link>
      </aside>

      <section className="overflow-hidden rounded-2xl border border-border bg-[#101416] text-white">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div><p className="text-xs uppercase tracking-[0.18em] text-white/45">Evidence replay</p><h2 className="font-display text-xl font-bold">{activeRoom?.name ?? "Room"}</h2></div><span className="rounded-full bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-200">AI measured · estimator verifies</span></div>
        <div className="relative aspect-video bg-black">
          {activeMedia?.kind === "photo" ? <img src={activeMedia.url} alt="Room evidence" className="size-full object-contain" /> : activeMedia ? <video ref={videoRef} src={activeMedia.url} controls playsInline className="size-full object-contain" /> : <div className="grid size-full place-items-center text-sm text-white/45">No processed media for this room</div>}
          {activeMedia && <div className="pointer-events-none absolute inset-5 border border-cyan-300/20"><span className="absolute -left-px -top-px size-7 border-l-2 border-t-2 border-cyan-300" /><span className="absolute -bottom-px -right-px size-7 border-b-2 border-r-2 border-cyan-300" /></div>}
        </div>
        <div className="p-4"><p className="text-sm text-white/60">Tap an evidence time beside an item to replay where AI saw it. The boxes and scan treatment show evidence context, not an automatic final decision.</p></div>
      </section>

      <aside className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-mist-400">Detected inventory</p><p className="mt-1 text-sm text-mist-500">{unresolved ? `${unresolved} need review` : "Room review complete"}</p></div><button type="button" disabled={busy} onClick={() => mutate(() => acceptRoomDetectionsAction(activeRoomId), () => setItems((current) => current.map((item) => item.roomId === activeRoomId && item.state === "proposed" && !item.reviewReason ? { ...item, state: "accepted" } : item)))} className="focus-ring min-h-10 rounded-lg bg-mm-red-tint px-3 text-xs font-bold text-mm-red-deep">Accept clear items</button></div>
        <div className="mt-4 max-h-[62vh] space-y-3 overflow-y-auto pr-1">{roomItems.map((item) => <DetectionCard key={item.id} item={item} catalogue={catalogue} catalogueByKey={catalogueByKey} busy={busy} onSeek={seek} onReview={review} />)}</div>
        <button type="button" disabled={busy || unresolved > 0 || !manifest || !activeRoomId} onClick={() => mutate(() => confirmAiItemsAction(surveyId, activeRoomId, updatedAt), (result) => { if (result.ok) setUpdatedAt(result.updatedAt); toast.success(`${activeRoom?.name} confirmed and added to the cubic survey.`); router.refresh(); })} className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-mm-red font-semibold text-white disabled:opacity-35"><CheckCircle2 className="size-5" /> Confirm room inventory</button>
      </aside>
    </div>
  );
}

function DetectionCard({ item, catalogue, catalogueByKey, busy, onSeek, onReview }: { item: ReviewDetection; catalogue: CatalogueOption[]; catalogueByKey: Map<string, CatalogueOption>; busy: boolean; onSeek: (seconds: number) => void; onReview: (id: string, state: "accepted" | "rejected", resolution?: Parameters<typeof resolveDetectionAction>[1]["resolution"]) => void }) {
  const [key, setKey] = useState(item.catalogueKey ?? item.candidates[0]?.key ?? "");
  const [qty, setQty] = useState(String(item.qty));
  const [moving, setMoving] = useState<"moving" | "staying">(item.moving === "staying" ? "staying" : "moving");
  const selected = catalogueByKey.get(key);
  const needsEdit = !!item.reviewReason || item.moving === "uncertain" || !item.catalogueKey;
  return <article className={cn("rounded-xl border p-3", item.state === "rejected" ? "border-border bg-muted opacity-55" : item.state === "accepted" || item.state === "edited" ? "border-success-border bg-success-bg/40" : "border-border")}>
    <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.label}</p><p className="mt-0.5 text-xs text-mist-400">{selected?.title ?? "No catalogue match"} · {Math.round(item.confidence * 100)}% confidence</p></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-bold">×{item.qty}</span></div>
    {!!item.evidence.timestampsS?.length && <div className="mt-2 flex flex-wrap gap-1">{item.evidence.timestampsS.map((time) => <button type="button" key={time} onClick={() => onSeek(time)} className="focus-ring inline-flex min-h-8 items-center gap-1 rounded-full bg-cyan-50 px-2 text-xs font-semibold text-cyan-800"><Play className="size-3" /> {Math.floor(time / 60)}:{String(Math.round(time % 60)).padStart(2, "0")}</button>)}</div>}
    {needsEdit && item.state === "proposed" && <div className="mt-3 grid grid-cols-[1fr_64px] gap-2"><select value={key} onChange={(event) => setKey(event.target.value)} className="focus-ring h-11 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"><option value="">Choose item…</option>{catalogue.map((option) => <option key={option.key} value={option.key}>{option.title} · {option.ft3} ft³</option>)}</select><input value={qty} onChange={(event) => setQty(event.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" pattern="[0-9]*" aria-label="Quantity" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-center text-base" /><select value={moving} onChange={(event) => setMoving(event.target.value as "moving" | "staying")} className="focus-ring col-span-2 h-11 rounded-lg border border-input bg-background px-2 text-sm"><option value="moving">Moving</option><option value="staying">Staying at property</option></select></div>}
    <div className="mt-3 flex gap-2">{item.state === "proposed" && <><button type="button" disabled={busy || (needsEdit && (!key || !Number(qty)))} onClick={() => needsEdit ? onReview(item.id, "accepted", { type: "catalogue", catalogueKey: key, qty: Number(qty), moving, flags: { dismantle: !!item.flags.dismantle, fragile: !!item.flags.fragile } }) : onReview(item.id, "accepted")} className="focus-ring flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-success-bg text-sm font-bold text-success"><Check className="size-4" /> Accept</button><button type="button" disabled={busy} onClick={() => onReview(item.id, "rejected")} className="focus-ring flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-danger-bg text-sm font-bold text-danger"><X className="size-4" /> Not moving</button></>}</div>
  </article>;
}
