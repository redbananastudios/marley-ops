"use client";
/* eslint-disable @next/next/no-img-element -- local camera Blob URLs are not image-optimiser inputs */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Camera,
  Check,
  CircleStop,
  FileVideo,
  Loader2,
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
import { extractEvidenceFrames } from "@/lib/ai/frames";
import { uploadToMediaTarget } from "@/lib/storage/tus-upload";
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
  surveyId,
  initialConsent,
  initialRooms,
}: {
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
  const registrationRef = useRef<RegisteredUpload | null>(null);
  const [consented, setConsented] = useState(initialConsent);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<"verbal" | "digital">("verbal");
  const [rooms, setRooms] = useState(initialRooms);
  const [roomName, setRoomName] = useState("");
  const [selectedRoom, setSelectedRoom] = useState(initialRooms[0]?.id ?? "");
  const [recording, setRecording] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState<PendingMedia | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, startTransition] = useTransition();

  const allAcked = CONSENT_ACKS.every(([key]) => acks[key]);
  const selectedName = useMemo(
    () => rooms.find((room) => room.id === selectedRoom)?.name,
    [rooms, selectedRoom],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!recording && !uploading && !pending) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, uploading, pending]);

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
        hiddenStorageChecked: false,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRooms((current) => [...current, { id: result.roomId, name, status: "pending" }]);
      setSelectedRoom(result.roomId);
      setRoomName("");
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
        registrationRef.current = null;
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

  async function chooseFile(file: File) {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    registrationRef.current = null;
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
        roomId: selectedRoom || undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that file.");
    }
  }

  async function uploadPending() {
    if (!pending) return;
    setUploading(true);
    setProgress(0);
    try {
      const evidence = pending.kind === "photo" ? [] : await extractEvidenceFrames(pending.blob);
      const existing = registrationRef.current;
      const registration = existing ?? await registerMediaAction(surveyId, {
        roomId: pending.roomId,
        kind: pending.kind,
        mime: pending.mime,
        bytes: pending.blob.size,
        durationS: pending.durationS,
      });
      if (!registration.ok) throw new Error(registration.error);
      registrationRef.current = registration;
      await uploadToMediaTarget({
        target: registration.upload,
        file: pending.blob,
        onProgress: (value) => setProgress(value * 0.75),
      });

      const targets = await createFrameUploadTargetsAction(
        registration.mediaId,
        evidence.map((frame) => ({ t: frame.t, bytes: frame.blob.size })),
      );
      if (!targets.ok) throw new Error(targets.error);
      for (let index = 0; index < targets.frames.length; index += 1) {
        await uploadToMediaTarget({ target: targets.frames[index].upload, file: evidence[index].blob });
        setProgress(75 + ((index + 1) / Math.max(1, targets.frames.length)) * 20);
      }
      const finalised = await finalizeMediaUploadAction(
        registration.mediaId,
        targets.frames.map((frame) => ({ t: frame.t, path: frame.path })),
      );
      if (!finalised.ok) throw new Error(finalised.error);
      setProgress(100);
      toast.success(`${selectedName ?? "Media"} is queued for analysis.`);
      URL.revokeObjectURL(pending.previewUrl);
      setPending(null);
      registrationRef.current = null;
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed. Keep this page open and retry.");
    } finally {
      setUploading(false);
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
          {(["verbal", "digital"] as const).map((value) => <button key={value} type="button" onClick={() => setMethod(value)} className={cn("focus-ring min-h-11 flex-1 rounded-lg border px-3 text-sm font-semibold capitalize", method === value ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-border")}>{value} agreement</button>)}
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
            <button key={room.id} type="button" disabled={recording || uploading} onClick={() => setSelectedRoom(room.id)} className={cn("focus-ring flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left text-sm font-semibold disabled:opacity-50", selectedRoom === room.id ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-border bg-background")}>
              <span>{index + 1}. {room.name}</span><span className="text-[10px] uppercase tracking-wide opacity-70">{room.status.replace("_", " ")}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input value={roomName} onChange={(event) => setRoomName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addRoom(); }} placeholder="Add a room" className="focus-ring h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base" />
          <button type="button" aria-label="Add room" disabled={busy} onClick={addRoom} className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background"><Plus className="size-5" /></button>
        </div>
      </aside>

      <section className="overflow-hidden rounded-2xl border border-border bg-[#101416] text-white shadow-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div><p className="text-xs uppercase tracking-[0.18em] text-white/45">Now surveying</p><h2 className="font-display text-xl font-bold">{selectedName ?? "Choose a room"}</h2></div>
          <div className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300"><span className="size-2 rounded-full bg-emerald-400" /> Secure capture</div>
        </div>
        <div className="relative aspect-video min-h-[300px] bg-black">
          {pending ? (pending.kind === "photo" ? <img src={pending.previewUrl} alt="Selected room" className="size-full object-contain" /> : <video src={pending.previewUrl} controls playsInline className="size-full object-contain" />) : <video ref={previewRef} muted playsInline className="size-full object-cover" />}
          {!pending && !recording && <div className="absolute inset-0 grid place-items-center text-center text-white/55"><div><ScanLine className="mx-auto size-12" /><p className="mt-3 text-sm">Keep the room well lit and pan slowly</p></div></div>}
          {(recording || uploading) && <><div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-[scan_2.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_18px_4px_rgba(103,232,249,.55)]" /><div className="pointer-events-none absolute inset-5 border border-cyan-300/35"><span className="absolute -left-px -top-px size-5 border-l-2 border-t-2 border-cyan-300" /><span className="absolute -bottom-px -right-px size-5 border-b-2 border-r-2 border-cyan-300" /></div></>}
          {recording && <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-sm font-bold"><span className="size-2.5 animate-pulse rounded-full bg-red-500" /> REC {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</div>}
          {uploading && <div className="absolute inset-x-4 bottom-4 rounded-xl bg-black/75 p-3 backdrop-blur"><div className="flex justify-between text-xs font-semibold"><span>Preparing secure AI analysis</span><span>{Math.round(progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-cyan-300 transition-[width]" style={{ width: `${progress}%` }} /></div></div>}
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {!recording ? <button type="button" disabled={!selectedRoom || uploading} onClick={startRecording} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-mm-red font-semibold text-white disabled:opacity-40"><Camera className="size-5" /> Record room</button> : <button type="button" onClick={stopRecording} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white font-semibold text-black"><CircleStop className="size-5 text-mm-red" /> Stop recording</button>}
          <label className="focus-ring flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 font-semibold hover:bg-white/10"><FileVideo className="size-5" /> Import media<input type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png" className="sr-only" disabled={recording || uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.target.value = ""; }} /></label>
          <button type="button" disabled={!pending || uploading} onClick={uploadPending} className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cyan-300 font-semibold text-slate-950 disabled:opacity-35">{uploading ? <Loader2 className="size-5 animate-spin" /> : <UploadCloud className="size-5" />} Upload & analyse</button>
        </div>
        <label className="mx-4 mb-3 flex min-h-11 items-center gap-3 rounded-lg border border-white/10 px-3 text-sm text-white/70"><input type="checkbox" checked={audioEnabled} onChange={(event) => setAudioEnabled(event.target.checked)} disabled={recording} className="size-5 accent-mm-red" /> Record narration</label>
        <p className="px-4 pb-4 text-xs leading-5 text-white/45">Keep this page open until upload reaches 100%. AI suggestions never replace your review.</p>
      </section>
    </div>
  );
}
