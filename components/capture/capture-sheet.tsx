"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Job content capture sheet (docs/job-content-capture-prd.md v1.0) — the
 * one-thumb, camera-first surface. Photos + video ride the NATIVE camera
 * (`input capture` — the field-proven crew-notes path; the system camera
 * beats any custom PWA viewfinder); voice notes use the hold-to-record
 * recorder. Everything auto-attaches to the job — capture always wins over
 * metadata (tags/captions are optional, after the fact).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, Loader2, Mic, RotateCw, Video, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { VoiceRecorder as VoiceRecorderLazy } from "@/components/capture/voice-recorder";
import { uploadToMediaTarget } from "@/lib/storage/tus-upload";
import {
  extForMime,
  JOB_MEDIA_BUCKET,
  JOB_MEDIA_TAGS,
  MAX_ITEMS_PER_SAVE,
  MAX_VIDEO_BYTES,
  type JobMediaKind,
  type JobMediaTag,
} from "@/lib/job-media";
import {
  createJobMediaUploadTargetAction,
  discardJobMediaUploadAction,
  getCaptureContextAction,
  recordJobMediaAction,
  setLeadMediaConsentAction,
} from "@/app/actions/job-media";

export interface CaptureAnchor {
  leadId?: string;
  appointmentId?: string;
}

interface TrayItem {
  key: string;
  kind: JobMediaKind;
  path: string;
  previewUrl: string | null;
  progress: number; // 0-100
  status: "uploading" | "ready" | "failed";
  retry?: () => void;
  mime: string | null;
  bytes: number | null;
  durationS: number | null;
  caption: string;
  tag: JobMediaTag | null;
}

const TAG_LABELS: Record<JobMediaTag, string> = {
  before: "Before",
  after: "After",
  access: "Access",
  team: "Team",
  story: "Story",
  other: "Other",
};

/** ~2000px JPEG downscale so a 12MP HEIC doesn't eat the crew's data plan. */
async function downscalePhoto(file: File): Promise<{ blob: Blob; mime: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob) return { blob, mime: "image/jpeg" };
  } catch {
    /* HEIC decode can fail — upload the original, the office can still view it */
  }
  return { blob: file, mime: file.type || "image/jpeg" };
}

export function CaptureSheet({
  anchor,
  open,
  onClose,
}: {
  anchor: CaptureAnchor;
  open: boolean;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [ctx, setCtx] = useState<{ leadId: string; consent: string } | null>(null);
  const [mode, setMode] = useState<JobMediaKind>("photo");
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [askConsent, setAskConsent] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getCaptureContextAction(anchor).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        toast.error(res.error);
        onClose();
        return;
      }
      setCtx({ leadId: res.leadId, consent: res.consent });
      setAskConsent(res.consent === "unset");
    });
    return () => {
      cancelled = true;
    };
  }, [open, anchor, onClose]);

  // Lock body scroll while the sheet is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const upsertTray = useCallback((item: TrayItem) => {
    setTray((t) => {
      const idx = t.findIndex((x) => x.key === item.key);
      if (idx < 0) return [...t, item];
      const next = [...t];
      next[idx] = item;
      return next;
    });
  }, []);

  const patchTray = useCallback((key: string, patch: Partial<TrayItem>) => {
    setTray((t) => t.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }, []);

  const addPhotos = useCallback(
    async (files: FileList) => {
      if (!ctx) return;
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      for (const file of list) {
        if (tray.length >= MAX_ITEMS_PER_SAVE) {
          toast.error(`Up to ${MAX_ITEMS_PER_SAVE} items per save — save these first.`);
          break;
        }
        const { blob, mime } = await downscalePhoto(file);
        const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(mime)}`;
        const key = path;
        upsertTray({
          key,
          kind: "photo",
          path,
          previewUrl: URL.createObjectURL(blob),
          progress: 30,
          status: "uploading",
          mime,
          bytes: blob.size,
          durationS: null,
          caption: "",
          tag: null,
        });
        const { error } = await supabase.storage.from(JOB_MEDIA_BUCKET).upload(path, blob, {
          contentType: mime,
          upsert: false,
        });
        patchTray(key, error ? { status: "failed" } : { status: "ready", progress: 100 });
        if (error) toast.error(`Photo upload failed: ${error.message}`);
        else buzzOk();
      }
    },
    [ctx, patchTray, supabase, tray.length, upsertTray],
  );

  const addVideo = useCallback(
    async (file: File) => {
      if (!ctx) return;
      if (!file.type.startsWith("video/")) return;
      if (file.size > MAX_VIDEO_BYTES) {
        toast.error("That video is over 300MB — record a shorter clip.");
        return;
      }
      const mime = file.type || "video/mp4";
      const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(mime)}`;
      const key = path;
      const run = async () => {
        patchTray(key, { status: "uploading", progress: 0 });
        const target = await createJobMediaUploadTargetAction(anchor, { path, mime });
        if (!target.ok) {
          patchTray(key, { status: "failed" });
          toast.error(target.error);
          return;
        }
        try {
          await uploadToMediaTarget({
            target: target.target,
            file,
            onProgress: (pct) => patchTray(key, { progress: Math.round(pct) }),
          });
          patchTray(key, { status: "ready", progress: 100 });
          buzzOk();
        } catch {
          patchTray(key, { status: "failed" });
          toast.error("Video upload failed — tap retry when you have signal.");
        }
      };
      upsertTray({
        key,
        kind: "video",
        path,
        previewUrl: URL.createObjectURL(file),
        progress: 0,
        status: "uploading",
        retry: () => void run(),
        mime,
        bytes: file.size,
        durationS: null,
        caption: "",
        tag: null,
      });
      void run();
    },
    [anchor, ctx, patchTray, upsertTray],
  );

  const addVoice = useCallback(
    async (capture: { blob: Blob; mime: string; durationS: number }) => {
      if (!ctx) return;
      const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(capture.mime)}`;
      const key = path;
      upsertTray({
        key,
        kind: "audio",
        path,
        previewUrl: URL.createObjectURL(capture.blob),
        progress: 40,
        status: "uploading",
        mime: capture.mime,
        bytes: capture.blob.size,
        durationS: capture.durationS,
        caption: "",
        tag: null,
      });
      const { error } = await supabase.storage.from(JOB_MEDIA_BUCKET).upload(path, capture.blob, {
        contentType: capture.mime.split(";")[0],
        upsert: false,
      });
      patchTray(key, error ? { status: "failed" } : { status: "ready", progress: 100 });
      if (error) toast.error(`Voice note upload failed: ${error.message}`);
      else buzzOk();
    },
    [ctx, patchTray, supabase, upsertTray],
  );

  const removeItem = useCallback(
    (item: TrayItem) => {
      setTray((t) => t.filter((x) => x.key !== item.key));
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.status !== "failed") void discardJobMediaUploadAction(anchor, item.path, item.kind);
    },
    [anchor],
  );

  const save = useCallback(() => {
    const ready = tray.filter((t) => t.status === "ready");
    if (ready.length === 0) {
      toast.error("Nothing uploaded yet.");
      return;
    }
    startSaving(async () => {
      const res = await recordJobMediaAction(
        anchor,
        ready.map((t) => ({
          kind: t.kind,
          path: t.path,
          mime: t.mime,
          bytes: t.bytes,
          durationS: t.durationS,
          caption: t.caption,
          tag: t.tag,
        })),
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      tray.forEach((t) => t.previewUrl && URL.revokeObjectURL(t.previewUrl));
      setTray([]);
      toast.success(
        res.count === 1 ? "Filed to the job — the office can see it." : `${res.count} items filed to the job.`,
      );
      router.refresh();
      onClose();
    });
  }, [anchor, onClose, router, tray]);

  const setConsent = useCallback(
    (state: "granted" | "internal_only") => {
      void setLeadMediaConsentAction(anchor, state).then((res) => {
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        setCtx((c) => (c ? { ...c, consent: state } : c));
        setAskConsent(false);
      });
    },
    [anchor],
  );

  if (!open) return null;
  const readyCount = tray.filter((t) => t.status === "ready").length;
  const uploadingCount = tray.filter((t) => t.status === "uploading").length;
  const editing = tray.find((t) => t.key === editingKey) ?? null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-charcoal text-white" role="dialog" aria-modal="true" aria-label="Capture job content" style={{ height: "100dvh", background: "#1F1D1B" }}>
      {/* header */}
      <div className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/60">Job capture</p>
          {ctx ? (
            <p className="text-xs text-white/50">
              {ctx.consent === "granted"
                ? "Customer OK'd marketing use"
                : ctx.consent === "internal_only"
                  ? "Internal-only — no marketing use"
                  : "Consent not set yet"}
            </p>
          ) : (
            <p className="text-xs text-white/50">Loading…</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="focus-ring flex size-11 items-center justify-center rounded-full bg-white/10"
        >
          <X className="size-5" strokeWidth={1.75} />
        </button>
      </div>

      {/* consent card (first capture on the job) */}
      {askConsent ? (
        <div className="mx-4 mt-2 rounded-lg border border-white/15 bg-white/5 p-4 text-sm">
          <p className="font-medium">Quick one before you shoot</p>
          <p className="mt-1 text-white/70">
            Exteriors, the van and the crew are always fine. For anything inside the home, ask the customer
            first — are they happy for photos to be used in our marketing?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConsent("granted")}
              className="focus-ring min-h-11 rounded-md bg-mm-red px-4 text-sm font-semibold text-white"
            >
              Customer&apos;s OK&apos;d it
            </button>
            <button
              type="button"
              onClick={() => setConsent("internal_only")}
              className="focus-ring min-h-11 rounded-md border border-white/25 px-4 text-sm font-medium text-white/90"
            >
              Keep internal-only
            </button>
          </div>
        </div>
      ) : null}

      {/* main capture zone */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        {mode === "photo" ? (
          <button
            type="button"
            disabled={!ctx}
            onClick={() => photoInput.current?.click()}
            className="focus-ring flex size-24 items-center justify-center rounded-full bg-mm-red text-white shadow-[0_0_0_10px_rgba(192,56,56,0.2)] transition-transform active:scale-95 disabled:opacity-50"
            aria-label="Take photos"
          >
            <Camera className="size-10" strokeWidth={1.5} />
          </button>
        ) : mode === "video" ? (
          <button
            type="button"
            disabled={!ctx}
            onClick={() => videoInput.current?.click()}
            className="focus-ring flex size-24 items-center justify-center rounded-full bg-mm-red text-white shadow-[0_0_0_10px_rgba(192,56,56,0.2)] transition-transform active:scale-95 disabled:opacity-50"
            aria-label="Record a video"
          >
            <Video className="size-10" strokeWidth={1.5} />
          </button>
        ) : (
          <VoiceRecorderLazy disabled={!ctx} onCaptured={addVoice} />
        )}
        {mode !== "audio" ? (
          <p className="text-sm text-white/60">
            {mode === "photo" ? "Opens your camera — snap as many as you like" : "Opens your camera — short clips work best"}
          </p>
        ) : null}
      </div>

      {/* tray */}
      {tray.length > 0 ? (
        <div className="px-4 pb-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {tray.map((item) => (
              <div key={item.key} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingKey(item.key)}
                  className="relative block size-20 overflow-hidden rounded-lg border border-white/20 bg-white/5"
                  aria-label="Edit item"
                >
                  {item.kind === "photo" && item.previewUrl ? (
                    <img src={item.previewUrl} alt="" className="size-full object-cover" />
                  ) : item.kind === "video" && item.previewUrl ? (
                    <video src={item.previewUrl} muted playsInline className="size-full object-cover" />
                  ) : (
                    <span className="flex size-full items-center justify-center">
                      <Mic className="size-7 text-white/80" strokeWidth={1.5} />
                    </span>
                  )}
                  {item.status === "uploading" ? (
                    <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                      <span className="block h-full bg-mm-red transition-all" style={{ width: `${item.progress}%` }} />
                    </span>
                  ) : null}
                  {item.status === "failed" && item.retry ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <RotateCw
                        className="size-6 text-white"
                        strokeWidth={2}
                        onClick={(e) => {
                          e.stopPropagation();
                          item.retry?.();
                        }}
                      />
                    </span>
                  ) : null}
                  {item.tag ? (
                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                      {TAG_LABELS[item.tag]}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() => removeItem(item)}
                  className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-black/80 text-white"
                >
                  <X className="size-3.5" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* editing row */}
      {editing ? (
        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {JOB_MEDIA_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => patchTray(editing.key, { tag: editing.tag === tag ? null : tag })}
                className={`min-h-9 rounded-full px-3 text-xs font-medium ${
                  editing.tag === tag ? "bg-mm-red text-white" : "border border-white/25 text-white/80"
                }`}
              >
                {TAG_LABELS[tag]}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={editing.caption}
              onChange={(e) => patchTray(editing.key, { caption: e.target.value })}
              maxLength={300}
              placeholder="One-line note (optional) — e.g. wardrobe down the spiral stairs"
              className="focus-ring w-full rounded-md border border-white/20 bg-white/5 px-3 py-2.5 text-base text-white placeholder:text-white/40"
            />
            <button
              type="button"
              onClick={() => setEditingKey(null)}
              className="focus-ring min-h-11 shrink-0 rounded-md border border-white/25 px-3 text-sm text-white/90"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* footer: modes + save */}
      <div className="border-t border-white/10 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex rounded-full bg-white/10 p-1" role="tablist" aria-label="Capture mode">
            {(
              [
                { key: "photo", label: "Photo", icon: Camera },
                { key: "video", label: "Video", icon: Video },
                { key: "audio", label: "Voice", icon: Mic },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                onClick={() => setMode(key)}
                className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors ${
                  mode === key ? "bg-mm-red text-white" : "text-white/70"
                }`}
              >
                <Icon className="size-4" strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving || readyCount === 0 || uploadingCount > 0}
            className="focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-[#1F1D1B] disabled:opacity-40"
          >
            {saving || uploadingCount > 0 ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={2} />
            ) : (
              <Check className="size-4" strokeWidth={2.5} />
            )}
            {uploadingCount > 0 ? "Uploading…" : saving ? "Filing…" : `File ${readyCount || ""}`.trim()}
          </button>
        </div>
      </div>

      {/* hidden native inputs */}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e) => {
          if (e.target.files?.length) void addPhotos(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={videoInput}
        type="file"
        accept="video/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void addVideo(f);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

const buzzOk = () => {
  try {
    navigator.vibrate?.(10);
  } catch {
    /* not supported */
  }
};

/** The floating capture button (crew job page) — opens the sheet. */
export function CaptureFab({ anchor, captureCount }: { anchor: CaptureAnchor; captureCount?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Capture photos, video or a voice note"
        className="focus-ring fixed bottom-[calc(env(safe-area-inset-bottom)+92px)] right-4 z-40 flex size-14 items-center justify-center rounded-full bg-mm-red text-white shadow-lg transition-transform active:scale-95"
      >
        <Camera className="size-6" strokeWidth={1.75} />
        {captureCount ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-semibold text-[#1F1D1B]">
            {captureCount > 99 ? "99+" : captureCount}
          </span>
        ) : null}
      </button>
      <CaptureSheet anchor={anchor} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Inline launcher for office surfaces (lead page action bar). */
export function CaptureLauncher({ anchor, className }: { anchor: CaptureAnchor; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
        }
      >
        <Camera className="size-4" strokeWidth={1.75} />
        Capture
      </button>
      <CaptureSheet anchor={anchor} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
