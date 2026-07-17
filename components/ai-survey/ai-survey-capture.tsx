"use client";
/* eslint-disable @next/next/no-img-element -- local camera Blob URLs are not image-optimiser inputs */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Camera,
  Check,
  CircleStop,
  FileVideo,
  Loader2,
  Pause,
  Play,
  Plus,
  ScanLine,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";

import {
  createFrameUploadTargetsAction,
  createRoomAction,
  finalizeMediaUploadAction,
  registerMediaAction,
  saveAiConsentAction,
} from "@/app/actions/ai-survey";
import { applyMinimumCameraZoom } from "@/lib/ai/camera";
import { extractEvidenceFrames } from "@/lib/ai/frames";
import { uploadToMediaTarget, type MediaUploadControl } from "@/lib/storage/tus-upload";
import { cn } from "@/lib/utils";

interface CaptureRoom {
  id: string;
  name: string;
  status: string;
}

interface PendingMedia {
  blob: Blob;
  mime: "video/mp4" | "video/quicktime" | "video/webm" | "image/jpeg" | "image/png";
  kind: "room_video" | "import_video" | "photo";
  durationS?: number;
  previewUrl: string;
  roomId?: string;
}

interface UploadTask {
  id: string;
  label: string;
  progress: number;
  status: "uploading" | "paused" | "failed" | "complete";
  error?: string;
  control?: MediaUploadControl;
}

type RegisteredUpload = Extract<Awaited<ReturnType<typeof registerMediaAction>>, { ok: true }>;

const CONSENT_ACKS = [
  ["filming", "The customer agrees to the room being filmed."],
  ["audio", "They understand narration may be recorded."],
  ["aiProcessing", "They agree that AI will identify moving items."],
  ["manualAlternative", "I offered the normal manual survey as an alternative."],
] as const;

function recorderMime(): string | null {
  for (const mime of [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

async function videoDuration(file: Blob): Promise<number> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Video format is not supported."));
    });
    return Math.round(video.duration * 10) / 10;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AiSurveyCapture({
  leadId,
  surveyId,
  initialConsent,
  initialRooms,
}: {
  leadId: string;
  surveyId: string;
  initialConsent: boolean;
  initialRooms: CaptureRoom[];
}) {
  const router = useRouter();
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const secondsRef = useRef(0);
  const uploadAssetsRef = useRef(new Map<string, { media: PendingMedia; registration?: RegisteredUpload }>());
  const [consented, setConsented] = useState(initialConsent);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<"verbal" | "digital">("verbal");
  const [rooms, setRooms] = useState(initialRooms);
  const [roomName, setRoomName] = useState("");
  const [roomFloor, setRoomFloor] = useState("");
  const [hiddenStorageChecked, setHiddenStorageChecked] = useState(false);
  const [wholePropertyImport, setWholePropertyImport] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState(initialRooms[0]?.id ?? "");
  const [recording, setRecording] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState<PendingMedia | null>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [busy, startTransition] = useTransition();

  const allAcked = CONSENT_ACKS.every(([key]) => acks[key]);
  const selectedName = useMemo(
    () => rooms.find((room) => room.id === selectedRoom)?.name,
    [rooms, selectedRoom],
  );
  const selectedRoomState = useMemo(
    () => rooms.find((room) => room.id === selectedRoom),
    [rooms, selectedRoom],
  );
  const roomPresets = useMemo(() => {
    const bedrooms = rooms.filter((room) => /^bedroom\b/i.test(room.name)).length;
    return ["Living room", "Kitchen", `Bedroom ${bedrooms + 1}`, "Garage", "Loft", "Shed"];
  }, [rooms]);
  const activeUploads = uploads.filter((upload) => upload.status !== "complete");

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!recording && activeUploads.length === 0 && !pending) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, activeUploads.length, pending]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden" && recorderRef.current?.state === "recording") stopRecording();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stopWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stopWhenHidden);
    };
  });

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (pending) URL.revokeObjectURL(pending.previewUrl);
  }, [pending]);

  function saveConsent() {
    if (!allAcked) return;
    startTransition(async () => {
      const result = await saveAiConsentAction(surveyId, {
        textVersion: "ai-survey-v1",
        customerAgreed: true,
        agreementMethod: method,
        acks: {
          filming: true,
          audio: true,
          aiProcessing: true,
          manualAlternative: true,
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setConsented(true);
    });
  }

  function addRoom() {
    if (!roomName.trim()) return;
    startTransition(async () => {
      const name = roomName.trim();
      const result = await createRoomAction(surveyId, {
        name,
        floor: roomFloor || undefined,
        hiddenStorageChecked,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRooms((current) => [...current, { id: result.roomId, name, status: "pending" }]);
      setSelectedRoom(result.roomId);
      setRoomName("");
      setRoomFloor("");
      setHiddenStorageChecked(false);
    });
  }

  async function startRecording() {
    if (!selectedRoom) return toast.error("Add or choose a room first.");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return toast.error("This browser cannot record video. Use Import video instead.");
    }
    const mime = recorderMime();
    if (!mime) return toast.error("This device does not offer a supported recording format.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: audioEnabled,
      });
      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) await applyMinimumCameraZoom(videoTrack);
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play();
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      let finished = false;
      const finish = () => {
        if (finished || chunksRef.current.length === 0) return;
        finished = true;
        const actualMime = recorder.mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
        const blob = new Blob(chunksRef.current, { type: actualMime });
        stream.getTracks().forEach((track) => track.stop());
        if (previewRef.current) previewRef.current.srcObject = null;
        setPending({ blob, mime: actualMime, kind: "room_video", durationS: secondsRef.current, previewUrl: URL.createObjectURL(blob), roomId: selectedRoom });
        setRecording(false);
      };
      recorder.onstop = finish;
      recorder.onerror = () => { stream.getTracks().forEach((track) => track.stop()); setRecording(false); toast.error("Recording stopped unexpectedly. Please check the preview."); };
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => { if (recorder.state === "recording") recorder.stop(); }, { once: true }));
      recorder.addEventListener("stop", () => setTimeout(finish, 500), { once: true });
      setSeconds(0);
      secondsRef.current = 0;
      setRecording(true);
      recorder.start();
      timerRef.current = setInterval(() => {
        setSeconds((current) => {
          const next = Math.min(120, current + 1);
          secondsRef.current = next;
          if (next >= 120 && recorder.state === "recording") {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            recorder.stop();
          }
          return next;
        });
      }, 1_000);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      toast.error("Camera or microphone permission was denied.");
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function discardPending() {
    if (!pending) return;
    URL.revokeObjectURL(pending.previewUrl);
    setPending(null);
  }

  async function chooseFile(file: File) {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    const mime = file.type as PendingMedia["mime"];
    if (!["video/mp4", "video/quicktime", "video/webm", "image/jpeg", "image/png"].includes(mime)) {
      return toast.error("Choose an MP4, MOV, WebM, JPEG or PNG file.");
    }
    const isVideo = mime.startsWith("video/");
    try {
      setPending({
        blob: file,
        mime,
        kind: isVideo ? "import_video" : "photo",
        durationS: isVideo ? await videoDuration(file) : undefined,
        previewUrl: URL.createObjectURL(file),
        roomId: isVideo && wholePropertyImport ? undefined : selectedRoom || undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that file.");
    }
  }

  function updateUpload(id: string, patch: Partial<UploadTask>) {
    setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, ...patch } : upload));
  }

  async function runUpload(id: string) {
    const asset = uploadAssetsRef.current.get(id);
    if (!asset) return;
    const media = asset.media;
    updateUpload(id, { status: "uploading", error: undefined });
    try {
      const evidence = media.kind === "photo" ? [] : await extractEvidenceFrames(media.blob);
      const existing = asset.registration;
      const registration = existing ?? await registerMediaAction(surveyId, {
        roomId: media.roomId,
        kind: media.kind,
        mime: media.mime,
        bytes: media.blob.size,
        durationS: media.durationS,
      });
      if (!registration.ok) throw new Error(registration.error);
      asset.registration = registration;
      await uploadToMediaTarget({
        target: registration.upload,
        file: media.blob,
        onProgress: (value) => updateUpload(id, { progress: value * 0.75 }),
        onControl: (control) => updateUpload(id, { control }),
      });

      const targets = await createFrameUploadTargetsAction(
        registration.mediaId,
        evidence.map((frame) => ({ t: frame.t, bytes: frame.blob.size })),
      );
      if (!targets.ok) throw new Error(targets.error);
      for (let index = 0; index < targets.frames.length; index += 1) {
        await uploadToMediaTarget({ target: targets.frames[index].upload, file: evidence[index].blob });
        updateUpload(id, { progress: 75 + ((index + 1) / Math.max(1, targets.frames.length)) * 20, control: undefined });
      }
      const finalised = await finalizeMediaUploadAction(
        registration.mediaId,
        targets.frames.map((frame) => ({ t: frame.t, path: frame.path })),
      );
      if (!finalised.ok) throw new Error(finalised.error);
      updateUpload(id, { progress: 100, status: "complete", control: undefined });
      if (media.roomId) {
        setRooms((current) => current.map((room) => room.id === media.roomId ? { ...room, status: "processing" } : room));
      }
      toast.success("Upload complete. AI is analysing the room.");
      URL.revokeObjectURL(media.previewUrl);
      uploadAssetsRef.current.delete(id);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed. Keep this page open and retry.";
      updateUpload(id, { status: "failed", error: message, control: undefined });
      toast.error(message);
    }
  }

  function uploadPending() {
    if (!pending) return;
    const id = crypto.randomUUID();
    const label = rooms.find((room) => room.id === pending.roomId)?.name ?? (pending.roomId ? "Room media" : "Whole property");
    uploadAssetsRef.current.set(id, { media: pending });
    setUploads((current) => [...current, { id, label, progress: 0, status: "uploading" }]);
    setPending(null);
    void runUpload(id);
  }

  function toggleUpload(upload: UploadTask) {
    if (!upload.control) return;
    if (upload.status === "paused") {
      upload.control.resume();
      updateUpload(upload.id, { status: "uploading" });
    } else {
      upload.control.pause();
      updateUpload(upload.id, { status: "paused" });
    }
  }

  if (!consented) {
    return (
      <section className="mx-auto max-w-2xl rounded-2xl border border-border bg-card p-5 shadow-sm md:p-7">
        <div className="flex size-12 items-center justify-center rounded-xl bg-mm-red-tint text-mm-red-deep">
          <ShieldCheck className="size-6" />
        </div>
        <h2 className="mt-4 font-display text-2xl font-bold">Record the customer agreement</h2>
        <p className="mt-2 text-sm leading-6 text-mist-500">Explain that room video and narration will be securely processed by AI to prepare an item list. The normal manual survey remains available.</p>
        <div className="mt-5 space-y-3">
          {CONSENT_ACKS.map(([key, label]) => (
            <label key={key} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 text-sm">
              <input type="checkbox" className="mt-1 size-5 accent-mm-red" checked={!!acks[key]} onChange={(event) => setAcks((current) => ({ ...current, [key]: event.target.checked }))} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          {(["verbal", "digital"] as const).map((value) => <button key={value} type="button" onClick={() => setMethod(value)} className={cn("focus-ring min-h-11 flex-1 rounded-lg border px-3 text-sm font-semibold capitalize", method === value ? "border-mm-red bg-mm-red text-white" : "border-border")}>{value} agreement</button>)}
        </div>
        <button type="button" disabled={!allAcked || busy} onClick={saveConsent} className="focus-ring mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-mm-red px-4 font-semibold text-white disabled:opacity-40">
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />} Agreement recorded
        </button>
      </section>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <aside className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-mist-400">Rooms</p>
        <div className="mt-3 space-y-2">
          {rooms.map((room, index) => (
            <button key={room.id} type="button" disabled={recording} onClick={() => setSelectedRoom(room.id)} className={cn("focus-ring flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left text-sm font-semibold disabled:opacity-50", selectedRoom === room.id ? "border-mm-red bg-mm-red text-white" : "border-border bg-background")}>
              <span>{index + 1}. {room.name}</span><span className="text-[10px] uppercase tracking-wide opacity-70">{room.status.replace("_", " ")}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input value={roomName} onChange={(event) => setRoomName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addRoom(); }} placeholder="Add a room" className="focus-ring h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base" />
          <button type="button" aria-label="Add room" disabled={busy} onClick={addRoom} className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background"><Plus className="size-5" /></button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{roomPresets.map((preset) => <button key={preset} type="button" onClick={() => setRoomName(preset)} className="focus-ring min-h-9 rounded-pill bg-muted px-2.5 text-xs font-semibold text-mist-500">{preset}</button>)}</div>
        <input value={roomFloor} onChange={(event) => setRoomFloor(event.target.value.slice(0, 60))} placeholder="Floor (optional)" className="focus-ring mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-base" />
        <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-mist-500"><input type="checkbox" checked={hiddenStorageChecked} onChange={(event) => setHiddenStorageChecked(event.target.checked)} className="size-5 accent-mm-red" /> Cupboards and hidden storage checked</label>
      </aside>

      <section className="overflow-hidden rounded-2xl border border-border bg-[#101416] text-white shadow-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div><p className="text-xs uppercase tracking-[0.18em] text-white/45">Now surveying</p><h2 className="font-display text-xl font-bold">{selectedName ?? "Choose a room"}</h2></div>
          <div className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300"><span className="size-2 rounded-full bg-emerald-400" /> Secure capture</div>
        </div>
        <div className="relative aspect-[3/4] overflow-hidden bg-black sm:aspect-video">
          {pending ? (pending.kind === "photo" ? <img src={pending.previewUrl} alt="Selected room" className="size-full object-contain" /> : <video src={pending.previewUrl} controls playsInline className="size-full object-contain" />) : <video ref={previewRef} muted playsInline className="size-full object-cover" />}
          {!pending && !recording && <div className="absolute inset-0 grid place-items-center text-center text-white/55"><div><ScanLine className="mx-auto size-12" /><p className="mt-3 text-sm">Keep the room well lit and pan slowly</p></div></div>}
          {recording && <><div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-[scan_2.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_18px_4px_rgba(103,232,249,.55)]" /><div className="pointer-events-none absolute inset-5 border border-cyan-300/35"><span className="absolute -left-px -top-px size-5 border-l-2 border-t-2 border-cyan-300" /><span className="absolute -bottom-px -right-px size-5 border-b-2 border-r-2 border-cyan-300" /></div></>}
          {recording && <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-sm font-bold"><span className="size-2.5 animate-pulse rounded-full bg-red-500" /> REC {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</div>}
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {recording ? <button type="button" onClick={stopRecording} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white font-semibold text-black"><CircleStop className="size-5 text-mm-red" /> Stop recording</button> : pending ? <button type="button" onClick={discardPending} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 font-semibold"><Camera className="size-5" /> Retake</button> : <button type="button" disabled={!selectedRoom} onClick={startRecording} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-mm-red font-semibold text-white disabled:opacity-40"><Camera className="size-5" /> Record room</button>}
          <label id="import-media" className="focus-ring flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 font-semibold hover:bg-white/10"><FileVideo className="size-5" /> Import media<input type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png" className="sr-only" disabled={recording || !!pending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.target.value = ""; }} /></label>
          <button type="button" disabled={!pending} onClick={uploadPending} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cyan-300 font-semibold text-slate-950 disabled:opacity-35"><UploadCloud className="size-5" /> Use clip</button>
        </div>
        {!!activeUploads.length && <div className="mx-4 mb-3 space-y-2">{activeUploads.map((upload) => <div key={upload.id} className="rounded-xl border border-white/10 bg-white/5 p-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex justify-between text-xs font-semibold"><span className="truncate">{upload.label}</span><span>{upload.status === "failed" ? "Upload failed" : `${Math.round(upload.progress)}%`}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/15"><div className={cn("h-full rounded-full transition-[width]", upload.status === "failed" ? "bg-red-400" : "bg-cyan-300")} style={{ width: `${Math.max(upload.progress, upload.status === "failed" ? 5 : 0)}%` }} /></div>{upload.error && <p className="mt-1 truncate text-[11px] text-red-300">{upload.error}</p>}</div>{upload.status === "failed" ? <button type="button" onClick={() => void runUpload(upload.id)} className="focus-ring min-h-11 rounded-lg border border-white/20 px-3 text-xs font-bold">Retry</button> : upload.control && <button type="button" onClick={() => toggleUpload(upload)} className="focus-ring grid size-11 shrink-0 place-items-center rounded-lg border border-white/20" aria-label={upload.status === "paused" ? "Resume upload" : "Pause upload"}>{upload.status === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}</button>}</div></div>)}</div>}
        {selectedRoomState?.status === "processing" && <div className="mx-4 mb-3 flex items-start gap-3 rounded-xl border border-cyan-300/25 bg-cyan-300/10 p-3 text-cyan-50"><Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-cyan-300" /><div><p className="text-sm font-bold">AI is analysing {selectedRoomState.name}</p><p className="mt-0.5 text-xs leading-5 text-cyan-50/70">Usually ready within two minutes. You can add and scan the next room while this runs.</p></div></div>}
        {selectedRoomState?.status === "ready" && <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300/25 bg-emerald-300/10 p-3"><div className="flex items-center gap-2 text-emerald-50"><Check className="size-5 text-emerald-300" /><div><p className="text-sm font-bold">{selectedRoomState.name} is ready</p><p className="text-xs text-emerald-50/70">Check every detected item before it enters the cubic survey.</p></div></div><Link href={`/leads/${leadId}/cubic/review?room=${selectedRoomState.id}`} className="focus-ring inline-flex min-h-11 items-center rounded-lg bg-emerald-300 px-4 text-sm font-bold text-emerald-950">Review items</Link></div>}
        <label className="mx-4 mb-3 flex min-h-11 items-center gap-3 rounded-lg border border-white/10 px-3 text-sm text-white/70"><input type="checkbox" checked={wholePropertyImport} onChange={(event) => setWholePropertyImport(event.target.checked)} disabled={recording || !!pending} className="size-5 accent-mm-red" /> Imported video covers multiple rooms</label>
        <label className="mx-4 mb-3 flex min-h-11 items-center gap-3 rounded-lg border border-white/10 px-3 text-sm text-white/70"><input type="checkbox" checked={audioEnabled} onChange={(event) => setAudioEnabled(event.target.checked)} disabled={recording} className="size-5 accent-mm-red" /> Record narration</label>
        <p className="px-4 pb-4 text-xs leading-5 text-white/45">Keep this page open until upload reaches 100%. AI suggestions never replace your review.</p>
      </section>
    </div>
  );
}
