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

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, Loader2, Mic, RotateCw, Video, X } from "lucide-react";
import { toast } from "sonner";
import { VoiceRecorder as VoiceRecorderLazy } from "@/components/capture/voice-recorder";
import { uploadToMediaTarget } from "@/lib/storage/tus-upload";
import {
  extForMime,
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
  /** Source bytes retained so a failed upload can retry without re-shooting. */
  blob: Blob;
  previewUrl: string | null;
  progress: number; // 0-100
  status: "uploading" | "ready" | "failed";
  retry?: () => void;
  /** Stops the in-flight video transfer (TUS) — removal must not keep uploading. */
  abort?: () => void;
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

/** Some Android camera apps hand back files with an EMPTY type — infer from
 *  the extension rather than silently dropping the capture. */
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
};

function resolveMime(file: File, kind: "photo" | "video"): string | null {
  const prefix = kind === "photo" ? "image/" : "video/";
  if (file.type.startsWith(prefix)) return file.type;
  if (file.type) return null;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const inferred = EXT_MIME[ext];
  return inferred?.startsWith(prefix) ? inferred : null;
}

/** ~2000px JPEG downscale so a 12MP HEIC doesn't eat the crew's data plan. */
async function downscalePhoto(file: File, fallbackMime: string): Promise<{ blob: Blob; mime: string }> {
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
  return { blob: file, mime: fallbackMime };
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
  const router = useRouter();
  const [ctx, setCtx] = useState<{ leadId: string; consent: string } | null>(null);
  const [ctxError, setCtxError] = useState(false);
  const [ctxAttempt, setCtxAttempt] = useState(0);
  const [mode, setMode] = useState<JobMediaKind>("photo");
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [askConsent, setAskConsent] = useState(false);
  const [recordingLive, setRecordingLive] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  // Synchronous mirror of the tray — cap checks and save() must read the LIVE
  // list; a multi-select loop never re-renders, so render closures go stale.
  const trayRef = useRef<TrayItem[]>([]);
  const setTrayTracked = useCallback((updater: (t: TrayItem[]) => TrayItem[]) => {
    trayRef.current = updater(trayRef.current);
    setTray(trayRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCtxError(false);
    void getCaptureContextAction(anchor)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          toast.error(res.error);
          onClose();
          return;
        }
        setCtx({ leadId: res.leadId, consent: res.consent });
        setAskConsent(res.consent === "unset");
      })
      .catch(() => {
        // Offline open must not strand the sheet on "Loading…" with no way out.
        if (!cancelled) setCtxError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, anchor, onClose, ctxAttempt]);

  // Lock body scroll while the sheet is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const patchTray = useCallback(
    (key: string, patch: Partial<TrayItem>) => {
      setTrayTracked((t) => t.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    },
    [setTrayTracked],
  );

  // The 12-item cap is enforced here against the live tray, never a closure.
  const admitToTray = useCallback(
    (item: TrayItem): boolean => {
      if (trayRef.current.length >= MAX_ITEMS_PER_SAVE) return false;
      setTrayTracked((t) => [...t, item]);
      return true;
    },
    [setTrayTracked],
  );

  const addPhotos = useCallback(
    async (files: FileList) => {
      if (!ctx) return;
      const incoming: { file: File; mime: string }[] = [];
      let unsupported = 0;
      for (const file of Array.from(files)) {
        const mime = resolveMime(file, "photo");
        if (!mime || extForMime(mime) === "bin") {
          unsupported += 1;
          continue;
        }
        incoming.push({ file, mime });
      }
      if (unsupported > 0) {
        toast.error(
          unsupported === 1 ? "That file type isn't supported." : `${unsupported} files aren't a supported type.`,
        );
      }
      let capSkipped = 0;
      for (const entry of incoming) {
        if (trayRef.current.length >= MAX_ITEMS_PER_SAVE) {
          capSkipped += 1;
          continue;
        }
        const { blob, mime } = await downscalePhoto(entry.file, entry.mime);
        const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(mime)}`;
        const key = path;
        const run = async () => {
          patchTray(key, { status: "uploading", progress: 30 });
          try {
            const target = await createJobMediaUploadTargetAction(anchor, { path, mime, kind: "photo" });
            if (!target.ok) throw new Error(target.error);
            await uploadToMediaTarget({
              target: target.target,
              file: blob,
              onProgress: (pct) => patchTray(key, { progress: Math.round(pct) }),
            });
            patchTray(key, { status: "ready", progress: 100 });
            buzzOk();
          } catch {
            patchTray(key, { status: "failed" });
            toast.error("Photo upload failed — tap retry when you have signal.");
          }
        };
        const item: TrayItem = {
          key,
          kind: "photo",
          path,
          blob,
          previewUrl: URL.createObjectURL(blob),
          progress: 30,
          status: "uploading",
          retry: () => void run(),
          mime,
          bytes: blob.size,
          durationS: null,
          caption: "",
          tag: null,
        };
        if (!admitToTray(item)) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          capSkipped += 1;
          continue;
        }
        await run();
      }
      if (capSkipped > 0) {
        toast.error(
          `Up to ${MAX_ITEMS_PER_SAVE} items per save — ${capSkipped} photo${capSkipped === 1 ? "" : "s"} skipped. File these first.`,
        );
      }
    },
    [admitToTray, anchor, ctx, patchTray],
  );

  const addVideo = useCallback(
    async (file: File) => {
      if (!ctx) return;
      const mime = resolveMime(file, "video");
      if (!mime || extForMime(mime) === "bin") {
        toast.error("That file type isn't supported.");
        return;
      }
      if (file.size > MAX_VIDEO_BYTES) {
        toast.error("That video is over 300MB — record a shorter clip.");
        return;
      }
      const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(mime)}`;
      const key = path;
      const run = async () => {
        patchTray(key, { status: "uploading", progress: 0 });
        try {
          // Fresh target every attempt — a retry must never reuse a stale token.
          const target = await createJobMediaUploadTargetAction(anchor, { path, mime, kind: "video" });
          if (!target.ok) {
            patchTray(key, { status: "failed" });
            toast.error(target.error);
            return;
          }
          await uploadToMediaTarget({
            target: target.target,
            file,
            onProgress: (pct) => patchTray(key, { progress: Math.round(pct) }),
            // Removal mid-upload hard-stops the transfer (R2 PUT abort / TUS
            // terminate) so no orphaned object is left behind.
            onControl: (control) => patchTray(key, { abort: () => control.abort() }),
          });
          patchTray(key, { status: "ready", progress: 100 });
          buzzOk();
        } catch {
          patchTray(key, { status: "failed" });
          toast.error("Video upload failed — tap retry when you have signal.");
        }
      };
      const item: TrayItem = {
        key,
        kind: "video",
        path,
        blob: file,
        previewUrl: URL.createObjectURL(file),
        progress: 0,
        status: "uploading",
        retry: () => void run(),
        mime,
        bytes: file.size,
        durationS: null,
        caption: "",
        tag: null,
      };
      if (!admitToTray(item)) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        toast.error(`Up to ${MAX_ITEMS_PER_SAVE} items per save — file these first.`);
        return;
      }
      void run();
    },
    [admitToTray, anchor, ctx, patchTray],
  );

  const addVoice = useCallback(
    async (capture: { blob: Blob; mime: string; durationS: number }) => {
      if (!ctx) return;
      const path = `${ctx.leadId}/${crypto.randomUUID()}.${extForMime(capture.mime)}`;
      const key = path;
      const run = async () => {
        patchTray(key, { status: "uploading", progress: 40 });
        try {
          const target = await createJobMediaUploadTargetAction(anchor, {
            path,
            mime: capture.mime.split(";")[0],
            kind: "audio",
          });
          if (!target.ok) throw new Error(target.error);
          await uploadToMediaTarget({
            target: target.target,
            file: capture.blob,
            onProgress: (pct) => patchTray(key, { progress: Math.round(pct) }),
          });
          patchTray(key, { status: "ready", progress: 100 });
          buzzOk();
        } catch {
          patchTray(key, { status: "failed" });
          toast.error("Voice note upload failed — tap retry when you have signal.");
        }
      };
      const item: TrayItem = {
        key,
        kind: "audio",
        path,
        blob: capture.blob,
        previewUrl: URL.createObjectURL(capture.blob),
        progress: 40,
        status: "uploading",
        retry: () => void run(),
        mime: capture.mime,
        bytes: capture.blob.size,
        durationS: capture.durationS,
        caption: "",
        tag: null,
      };
      if (!admitToTray(item)) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        toast.error(`Up to ${MAX_ITEMS_PER_SAVE} items per save — file these first.`);
        return;
      }
      await run();
    },
    [admitToTray, anchor, ctx, patchTray],
  );

  const removeItem = useCallback(
    (item: TrayItem) => {
      if (item.status === "uploading") {
        // Stop the transfer first — removal must not keep burning the crew's
        // data or let the object land in storage after the discard below.
        try {
          item.abort?.();
        } catch {
          /* upload already settled */
        }
      }
      setTrayTracked((t) => t.filter((x) => x.key !== item.key));
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      // Discard for every status — a failed TUS upload can still leave partial
      // bytes server-side, and a missing object is a harmless no-op.
      discardJobMediaUploadAction(anchor, item.path, item.kind).catch(() => {
        /* offline — the object is unreferenced either way */
      });
    },
    [anchor, setTrayTracked],
  );

  const save = useCallback(() => {
    const ready = trayRef.current.filter((t) => t.status === "ready");
    if (ready.length === 0) {
      toast.error("Nothing uploaded yet.");
      return;
    }
    startSaving(async () => {
      let res: Awaited<ReturnType<typeof recordJobMediaAction>>;
      try {
        res = await recordJobMediaAction(
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
      } catch {
        // A dropped request must not reach the route error boundary — the tray
        // is the only copy of these captures. Everything stays "ready", so a
        // re-tap records without re-uploading.
        toast.error("No signal — your items are still here, try File again.");
        return;
      }
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const savedKeys = new Set(ready.map((t) => t.key));
      trayRef.current.forEach((t) => {
        if (savedKeys.has(t.key) && t.previewUrl) URL.revokeObjectURL(t.previewUrl);
      });
      // Clear ONLY the filed items — failed ones stay visible for retry/remove.
      setTrayTracked((t) => t.filter((x) => !savedKeys.has(x.key)));
      toast.success(
        res.count === 1 ? "Filed to the job — the office can see it." : `${res.count} items filed to the job.`,
      );
      router.refresh();
      const failedLeft = trayRef.current.filter((t) => t.status === "failed").length;
      if (trayRef.current.length === 0) {
        onClose();
      } else if (failedLeft > 0) {
        toast.warning(
          failedLeft === 1
            ? "1 item failed to upload — retry or remove it."
            : `${failedLeft} items failed to upload — retry or remove them.`,
        );
      }
    });
  }, [anchor, onClose, router, setTrayTracked]);

  const setConsent = useCallback(
    (state: "granted" | "internal_only") => {
      void setLeadMediaConsentAction(anchor, state)
        .then((res) => {
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          setCtx((c) => (c ? { ...c, consent: state } : c));
          setAskConsent(false);
        })
        .catch(() => {
          toast.error("No signal — that didn't save. Try again.");
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
            <p className="text-xs text-white/50">{ctxError ? "Couldn't load this job" : "Loading…"}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            if (recordingLive) {
              // Closing would silently bin a live voice note — make them decide.
              toast.info("Recording — stop or discard it first.");
              return;
            }
            onClose();
          }}
          aria-label="Close"
          className="focus-ring flex size-11 items-center justify-center rounded-full bg-white/10"
        >
          <X className="size-5" strokeWidth={1.75} />
        </button>
      </div>

      {/* context failed to load (no signal) — offer a retry instead of a dead end */}
      {!ctx && ctxError ? (
        <div className="mx-4 mt-2 rounded-lg border border-white/15 bg-white/5 p-4 text-sm">
          <p className="font-medium">No signal — couldn&apos;t load this job.</p>
          <button
            type="button"
            onClick={() => setCtxAttempt((n) => n + 1)}
            className="focus-ring mt-3 min-h-11 rounded-md bg-mm-red px-4 text-sm font-semibold text-white"
          >
            Retry
          </button>
        </div>
      ) : null}

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
          <VoiceRecorderLazy disabled={!ctx} onCaptured={addVoice} onRecordingChange={setRecordingLive} />
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
                  {item.status === "failed" ? (
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
                // A mode switch unmounts the recorder mid-recording — hold the tabs.
                disabled={recordingLive && key !== mode}
                onClick={() => setMode(key)}
                className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40 ${
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
