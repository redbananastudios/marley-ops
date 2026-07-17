"use client";

/**
 * Survey photo capture for one category (access | large_items), used inside the
 * quote builder so the in-person survey lives with the quote. Self-contained:
 * loads existing photos for the lead on mount, uploads via the media-store seam
 * (Cloudflare R2 in prod, Supabase in dev — the server mints the target), and
 * records/deletes rows via the survey actions. Photos hang off the lead's
 * survey row (created lazily) — they are not part of the priced quote, just the
 * visit evidence attached to it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { uploadToMediaTarget } from "@/lib/storage/tus-upload";
import {
  ensureSurveyForLead,
  recordSurveyPhoto,
  deleteSurveyPhoto,
  loadSurveyPhotos,
  createSurveyPhotoUploadTargetAction,
  signSurveyPhotoUrls,
} from "@/app/(dashboard)/leads/[id]/survey-actions";

type PhotoCategory = "access" | "large_items" | "cubic";

interface PhotoState {
  id: string;
  category: PhotoCategory;
  storage_path: string;
  url?: string;
}

export function SurveyPhotos({
  leadId,
  category,
  label,
}: {
  leadId: string;
  category: PhotoCategory;
  label: string;
}) {
  const [photos, setPhotos] = useState<PhotoState[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputId = `survey-photos-${category}`;

  const surveyIdRef = useRef<string | null>(null);

  const ensureSurvey = useCallback(async (): Promise<string | null> => {
    if (surveyIdRef.current) return surveyIdRef.current;
    const res = await ensureSurveyForLead(leadId);
    if (!res.ok) {
      toast.error(res.error || "Could not start the survey.");
      return null;
    }
    surveyIdRef.current = res.surveyId;
    return res.surveyId;
  }, [leadId]);

  const hydrateUrls = useCallback(async (rows: PhotoState[]) => {
    const needs = rows.filter((r) => !r.url);
    if (needs.length === 0) return;
    const res = await signSurveyPhotoUrls(needs.map((r) => r.storage_path));
    if (!res.ok) return;
    setPhotos((prev) =>
      prev.map((p) => {
        const url = res.urls[p.storage_path];
        return !p.url && url ? { ...p, url } : p;
      }),
    );
  }, []);

  // Load existing photos for this lead + category on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await loadSurveyPhotos(leadId);
      if (!alive || !res.ok) return;
      const mine = res.photos.filter((p) => p.category === category);
      if (mine.length) setPhotos(mine.map((p) => ({ ...p })));
    })();
    return () => {
      alive = false;
    };
  }, [leadId, category]);

  useEffect(() => {
    void hydrateUrls(photos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length]);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const id = await ensureSurvey();
      if (!id) return;
      setUploading((u) => u + list.length);
      for (const file of list) {
        try {
          const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
          const path = `${id}/${category}/${crypto.randomUUID()}.${ext}`;
          // Server mints the seam target (validates the path + keeps RLS on the
          // supabase driver); the browser then PUTs the file to it.
          const target = await createSurveyPhotoUploadTargetAction(id, category, {
            path,
            mime: file.type,
          });
          if (!target.ok) {
            toast.error(`Upload failed: ${target.error}`);
            continue;
          }
          await uploadToMediaTarget({ target: target.target, file });
          const rec = await recordSurveyPhoto(id, leadId, category, path);
          if (!rec?.ok) {
            toast.error("Photo saved to storage but not recorded.");
            continue;
          }
          const signed = await signSurveyPhotoUrls([path]);
          setPhotos((prev) => [
            ...prev,
            { id: crypto.randomUUID(), category, storage_path: path, url: signed.ok ? signed.urls[path] : undefined },
          ]);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Upload error.");
        } finally {
          setUploading((u) => Math.max(0, u - 1));
        }
      }
    },
    [ensureSurvey, leadId, category],
  );

  const removePhoto = useCallback(
    async (photo: PhotoState) => {
      const prev = photos;
      setPhotos((p) => p.filter((x) => x.id !== photo.id));
      const res = await deleteSurveyPhoto(photo.id, photo.storage_path, leadId);
      if (!res?.ok) {
        toast.error("Could not remove photo.");
        setPhotos(prev);
      }
    },
    [photos, leadId],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={inputId} className="text-sm">
          {label} photos
        </Label>
        {uploading > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-mist-400">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
            Uploading {uploading}…
          </span>
        )}
      </div>

      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex min-h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed bg-card px-4 py-4 text-center transition",
          dragOver ? "border-mm-red bg-accent" : "hover:bg-muted",
        )}
      >
        <Camera className="size-5 text-mist-400" strokeWidth={1.75} />
        <span className="text-xs text-mist-500">Tap to capture or add photos</span>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.currentTarget.value = "";
          }}
        />
      </label>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
              {photo.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.url} alt={`${label} survey photo`} className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} />
                </div>
              )}
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => removePhoto(photo)}
                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-foreground/70 text-white backdrop-blur-sm transition hover:bg-mm-red"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
