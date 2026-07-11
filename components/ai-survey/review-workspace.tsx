"use client";
/* eslint-disable @next/next/no-img-element -- signed private evidence URLs are not optimiser inputs */

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, ChevronRight, Play, ScanLine, X } from "lucide-react";
import { toast } from "sonner";

import {
  acceptRoomDetectionsAction,
  assignSegmentAction,
  confirmAiItemsAction,
  resolveDetectionAction,
  setRoomManifestCompleteAction,
} from "@/app/actions/ai-survey-review";
import { cn } from "@/lib/utils";

export interface ReviewRoom { id: string; name: string; status: string; coverage: string | null }
export interface ReviewMedia { id: string; roomId: string | null; kind: string; url: string }
export interface ReviewDetection {
  id: string; roomId: string | null; segmentId: string | null; label: string; catalogueKey: string | null;
  candidates: { key: string; confidence: number }[]; qty: number; confidence: number;
  moving: string; flags: { dismantle?: boolean; fragile?: boolean }; evidence: { kind?: string; timestampsS?: number[]; box2d?: number[] };
  reviewReason: string | null; state: string;
}
export interface CatalogueOption { key: string; title: string; ft3: number; category: string }
export interface ReviewSegment { id: string; proposedName: string; startS: number; endS: number; roomId: string | null; status: string }

export function ReviewWorkspace({ surveyId, leadId, initialUpdatedAt, manifestComplete, rooms, media, detections, catalogue, initialSegments }: {
  surveyId: string; leadId: string; initialUpdatedAt: string; manifestComplete: boolean;
  rooms: ReviewRoom[]; media: ReviewMedia[]; detections: ReviewDetection[]; catalogue: CatalogueOption[]; initialSegments: ReviewSegment[];
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeRoomId, setActiveRoomId] = useState(rooms[0]?.id ?? "");
  const [items, setItems] = useState(detections);
  const [manifest, setManifest] = useState(manifestComplete);
  const [segments, setSegments] = useState(initialSegments);
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
      if ("updatedAt" in result && typeof result.updatedAt === "string") setUpdatedAt(result.updatedAt);
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
    <div>
      {!!segments.filter((segment) => segment.status === "proposed").length && <section className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Whole-property video</p><h2 className="mt-1 font-display text-lg font-bold text-amber-950">Assign each proposed room before confirming</h2></div><div className="mt-3 grid gap-3 lg:grid-cols-2">{segments.filter((segment) => segment.status === "proposed").map((segment) => <SegmentAssignment key={segment.id} segment={segment} rooms={rooms} busy={busy} onAssign={(input) => mutate(() => assignSegmentAction(segment.id, input), (result) => { if (!result.ok) return; setManifest(false); setSegments((current) => current.map((entry) => entry.id === segment.id ? { ...entry, roomId: result.roomId, status: result.status } : entry)); setItems((current) => current.map((item) => item.segmentId === segment.id ? { ...item, roomId: result.roomId, state: result.status === "rejected" ? "rejected" : item.state } : item)); if (result.roomId) setActiveRoomId(result.roomId); router.refresh(); })} />)}</div></section>}
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
        <button type="button" disabled={busy || unresolved > 0 || !manifest || !activeRoomId || activeRoom?.status === "confirmed" || segments.some((segment) => segment.status === "proposed")} onClick={() => mutate(() => confirmAiItemsAction(surveyId, activeRoomId, updatedAt), (result) => { if (result.ok) setUpdatedAt(result.updatedAt); toast.success(`${activeRoom?.name} confirmed and added to the cubic survey.`); router.refresh(); })} className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-mm-red font-semibold text-white disabled:opacity-35"><CheckCircle2 className="size-5" /> {activeRoom?.status === "confirmed" ? "Room confirmed" : "Confirm room inventory"}</button>
      </aside>
      </div>
    </div>
  );
}

function SegmentAssignment({ segment, rooms, busy, onAssign }: { segment: ReviewSegment; rooms: ReviewRoom[]; busy: boolean; onAssign: (input: Parameters<typeof assignSegmentAction>[1]) => void }) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [newRoom, setNewRoom] = useState(segment.proposedName);
  const [createNew, setCreateNew] = useState(!rooms.length);
  const range = `${Math.floor(segment.startS / 60)}:${String(Math.round(segment.startS % 60)).padStart(2, "0")}–${Math.floor(segment.endS / 60)}:${String(Math.round(segment.endS % 60)).padStart(2, "0")}`;
  return <article className="rounded-xl border border-amber-200 bg-white p-3"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold text-amber-950">{segment.proposedName}</p><p className="text-xs text-amber-700">Video {range}</p></div><button type="button" disabled={busy} onClick={() => onAssign({ action: "reject" })} className="focus-ring min-h-9 rounded-lg px-2 text-xs font-bold text-danger">Reject segment</button></div><div className="mt-3 grid grid-cols-[1fr_auto] gap-2">{createNew ? <input value={newRoom} onChange={(event) => setNewRoom(event.target.value.slice(0, 60))} aria-label="New room name" className="focus-ring h-11 rounded-lg border border-input px-3 text-sm" /> : <select value={roomId} onChange={(event) => setRoomId(event.target.value)} className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-sm">{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select>}<button type="button" disabled={busy || (createNew ? !newRoom.trim() : !roomId)} onClick={() => onAssign(createNew ? { action: "assign", newRoom } : { action: "merge", roomId })} className="focus-ring min-h-11 rounded-lg bg-amber-900 px-3 text-sm font-bold text-white">{createNew ? "Create room" : "Merge"}</button></div><button type="button" onClick={() => setCreateNew((value) => !value)} className="focus-ring mt-2 min-h-8 rounded text-xs font-semibold text-amber-800">{createNew && rooms.length ? "Use an existing room" : "Create a new room"}</button></article>;
}

function DetectionCard({ item, catalogue, catalogueByKey, busy, onSeek, onReview }: { item: ReviewDetection; catalogue: CatalogueOption[]; catalogueByKey: Map<string, CatalogueOption>; busy: boolean; onSeek: (seconds: number) => void; onReview: (id: string, state: "accepted" | "rejected", resolution?: Parameters<typeof resolveDetectionAction>[1]["resolution"]) => void }) {
  const [key, setKey] = useState(item.catalogueKey ?? item.candidates[0]?.key ?? "");
  const [catalogueSearch, setCatalogueSearch] = useState(catalogueByKey.get(item.catalogueKey ?? item.candidates[0]?.key ?? "")?.title ?? "");
  const [qty, setQty] = useState(String(item.qty));
  const [moving, setMoving] = useState<"moving" | "staying">(item.moving === "staying" ? "staying" : "moving");
  const [custom, setCustom] = useState(false);
  const [customTitle, setCustomTitle] = useState(item.label);
  const [customCategory, setCustomCategory] = useState("Other");
  const [customFt3, setCustomFt3] = useState("");
  const selected = catalogueByKey.get(key);
  const needsEdit = !!item.reviewReason || item.moving === "uncertain" || !item.catalogueKey;
  const numericQty = Number(qty);
  const numericCustomFt3 = Number(customFt3);
  const correctedResolution = custom
    ? { type: "custom" as const, title: customTitle.trim(), category: customCategory.trim(), unitFt3: numericCustomFt3, qty: numericQty, moving, flags: { dismantle: !!item.flags.dismantle, fragile: !!item.flags.fragile } }
    : { type: "catalogue" as const, catalogueKey: key, qty: numericQty, moving, flags: { dismantle: !!item.flags.dismantle, fragile: !!item.flags.fragile } };
  const correctionInvalid = !numericQty || (custom ? !customTitle.trim() || !customCategory.trim() || !numericCustomFt3 : !key);
  return <article className={cn("rounded-xl border p-3", item.state === "rejected" ? "border-border bg-muted opacity-55" : item.state === "accepted" || item.state === "edited" ? "border-success-border bg-success-bg/40" : "border-border")}>
    <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.label}</p><p className="mt-0.5 text-xs text-mist-400">{selected?.title ?? "No catalogue match"} · {Math.round(item.confidence * 100)}% confidence</p></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-bold">×{item.qty}</span></div>
    {!!item.evidence.timestampsS?.length && <div className="mt-2 flex flex-wrap gap-1">{item.evidence.timestampsS.map((time) => <button type="button" key={time} onClick={() => onSeek(time)} className="focus-ring inline-flex min-h-8 items-center gap-1 rounded-full bg-cyan-50 px-2 text-xs font-semibold text-cyan-800"><Play className="size-3" /> {Math.floor(time / 60)}:{String(Math.round(time % 60)).padStart(2, "0")}</button>)}</div>}
    {needsEdit && item.state === "proposed" && <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1 text-xs font-bold"><button type="button" onClick={() => setCustom(false)} className={cn("min-h-9 rounded-md", !custom && "bg-background shadow-sm")}>Catalogue item</button><button type="button" onClick={() => setCustom(true)} className={cn("min-h-9 rounded-md", custom && "bg-background shadow-sm")}>Custom item</button></div>
      <div className="grid grid-cols-[1fr_64px] gap-2">
        {custom ? <><input value={customTitle} onChange={(event) => setCustomTitle(event.target.value.slice(0, 120))} placeholder="Item name" aria-label="Custom item name" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-sm" /><input value={qty} onChange={(event) => setQty(event.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" pattern="[0-9]*" aria-label="Quantity" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-center text-base" /><input value={customCategory} onChange={(event) => setCustomCategory(event.target.value.slice(0, 60))} placeholder="Category" aria-label="Custom item category" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-sm" /><input value={customFt3} onChange={(event) => setCustomFt3(event.target.value.replace(/[^0-9.]/g, "").slice(0, 7))} inputMode="decimal" placeholder="ft³" aria-label="Custom item cubic feet" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-center text-base" /></> : <><div><input list={`catalogue-${item.id}`} value={catalogueSearch} onChange={(event) => { const value = event.target.value; setCatalogueSearch(value); const match = catalogue.find((option) => option.title.toLocaleLowerCase() === value.trim().toLocaleLowerCase() || option.key === value); setKey(match?.key ?? ""); }} placeholder="Search Marley catalogue…" aria-label="Catalogue item" className="focus-ring h-11 w-full rounded-lg border border-input bg-background px-2 text-sm" /><datalist id={`catalogue-${item.id}`}>{catalogue.map((option) => <option key={option.key} value={option.title}>{option.ft3} ft³ · {option.category}</option>)}</datalist></div><input value={qty} onChange={(event) => setQty(event.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" pattern="[0-9]*" aria-label="Quantity" className="focus-ring h-11 rounded-lg border border-input bg-background px-2 text-center text-base" /></>}
        <select value={moving} onChange={(event) => setMoving(event.target.value as "moving" | "staying")} className="focus-ring col-span-2 h-11 rounded-lg border border-input bg-background px-2 text-sm"><option value="moving">Moving</option><option value="staying">Staying at property</option></select>
      </div>
    </div>}
    <div className="mt-3 flex gap-2">{item.state === "proposed" && <><button type="button" disabled={busy || (needsEdit && correctionInvalid)} onClick={() => needsEdit ? onReview(item.id, "accepted", correctedResolution) : onReview(item.id, "accepted")} className="focus-ring flex min-h-10 flex-1 items-center justify-center gap-1 rounded-lg bg-success-bg text-sm font-bold text-success"><Check className="size-4" /> Accept</button>{!needsEdit && <button type="button" disabled={busy} onClick={() => onReview(item.id, "accepted", { type: "catalogue", catalogueKey: item.catalogueKey!, qty: item.qty, moving: "staying", flags: { dismantle: !!item.flags.dismantle, fragile: !!item.flags.fragile } })} className="focus-ring min-h-10 flex-1 rounded-lg bg-amber-50 text-sm font-bold text-amber-800">Stays</button>}<button type="button" disabled={busy} onClick={() => onReview(item.id, "rejected")} className="focus-ring min-h-10 flex-1 rounded-lg bg-danger-bg text-sm font-bold text-danger"><X className="mr-1 inline size-4" /> Exclude</button></>}</div>
  </article>;
}
