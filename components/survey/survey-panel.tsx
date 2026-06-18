"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Camera, X, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ITEM_FIELDS, ZERO_ITEMS, type QuoteItems } from "@/lib/quote/form-types";
import { createClient } from "@/lib/supabase/client";
import { ensureSurveyForLead } from "@/app/(dashboard)/leads/[id]/survey-actions";
import {
  saveSurveyData,
  recordSurveyPhoto,
  deleteSurveyPhoto,
} from "@/app/(dashboard)/leads/[id]/survey-actions";

type PhotoCategory = "access" | "large_items";

interface SurveyPhotoRow {
  id: string;
  category: PhotoCategory;
  storage_path: string;
}

interface PhotoState extends SurveyPhotoRow {
  url?: string;
}

interface SurveyPanelProps {
  leadId: string;
  surveyId: string | null;
  initialData?: {
    items?: Partial<QuoteItems>;
    accessNotes?: string;
    largeItemsNotes?: string;
  };
  initialPhotos?: SurveyPhotoRow[];
}

const BUCKET = "survey-photos";
const SAVE_DEBOUNCE_MS = 800;

const PHOTO_GROUPS: { category: PhotoCategory; label: string }[] = [
  { category: "access", label: "Access" },
  { category: "large_items", label: "Large Items / Extra Packing" },
];

export function SurveyPanel({
  leadId,
  surveyId: initialSurveyId,
  initialData,
  initialPhotos = [],
}: SurveyPanelProps) {
  const supabase = useMemo(() => createClient(), []);
  const [surveyId, setSurveyId] = useState<string | null>(initialSurveyId);

  const [items, setItems] = useState<QuoteItems>({
    ...ZERO_ITEMS,
    ...(initialData?.items ?? {}),
  });
  const [accessNotes, setAccessNotes] = useState(initialData?.accessNotes ?? "");
  const [largeItemsNotes, setLargeItemsNotes] = useState(
    initialData?.largeItemsNotes ?? "",
  );

  const [photos, setPhotos] = useState<PhotoState[]>(
    initialPhotos.map((p) => ({ ...p })),
  );
  const [uploading, setUploading] = useState<Record<PhotoCategory, number>>({
    access: 0,
    large_items: 0,
  });
  const [dragOver, setDragOver] = useState<PhotoCategory | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completed, setCompleted] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the auto-save on the very first render (data is already persisted).
  const dirty = useRef(false);

  // --- Ensure a survey row exists; lazily on mount so photo upload + save have an id.
  const surveyIdRef = useRef<string | null>(initialSurveyId);
  surveyIdRef.current = surveyId;

  const ensureSurvey = useCallback(async (): Promise<string | null> => {
    if (surveyIdRef.current) return surveyIdRef.current;
    const res = await ensureSurveyForLead(leadId);
    if (!res.ok) {
      toast.error(res.error || "Could not start the survey.");
      return null;
    }
    surveyIdRef.current = res.surveyId;
    setSurveyId(res.surveyId);
    return res.surveyId;
  }, [leadId]);

  // --- Signed-URL hydration for thumbnails.
  const hydrateUrls = useCallback(
    async (rows: PhotoState[]) => {
      const needs = rows.filter((r) => !r.url);
      if (needs.length === 0) return;
      const results = await Promise.all(
        needs.map(async (r) => {
          const { data } = await supabase.storage
            .from(BUCKET)
            .createSignedUrl(r.storage_path, 3600);
          return { id: r.id, url: data?.signedUrl };
        }),
      );
      setPhotos((prev) =>
        prev.map((p) => {
          const hit = results.find((x) => x.id === p.id);
          return hit?.url ? { ...p, url: hit.url } : p;
        }),
      );
    },
    [supabase],
  );

  useEffect(() => {
    void hydrateUrls(photos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length]);

  // --- Debounced silent save of item counts + notes.
  const persist = useCallback(
    async (status?: "completed") => {
      const id = await ensureSurvey();
      if (!id) return false;
      const res = await saveSurveyData(
        id,
        leadId,
        { items, accessNotes, largeItemsNotes },
        status,
      );
      if (!res.ok) {
        toast.error(res.error || "Survey could not be saved.");
        return false;
      }
      return true;
    },
    [ensureSurvey, leadId, items, accessNotes, largeItemsNotes],
  );

  useEffect(() => {
    if (!dirty.current) {
      dirty.current = true;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, accessNotes, largeItemsNotes]);

  // --- Item stepper helpers.
  const setQty = useCallback((key: keyof QuoteItems, next: number) => {
    setItems((prev) => ({ ...prev, [key]: Math.max(0, next) }));
  }, []);

  const grouped = useMemo(() => {
    const boxes = ITEM_FIELDS.filter((f) => f.group === "Boxes");
    const covers = ITEM_FIELDS.filter((f) => f.group === "Covers");
    return { Boxes: boxes, Covers: covers };
  }, []);

  // --- Photo upload.
  const uploadFiles = useCallback(
    async (category: PhotoCategory, files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const id = await ensureSurvey();
      if (!id) return;

      setUploading((u) => ({ ...u, [category]: u[category] + list.length }));

      for (const file of list) {
        try {
          const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
          const path = `${id}/${category}/${crypto.randomUUID()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(path, file, { upsert: false });
          if (upErr) {
            toast.error(`Upload failed: ${upErr.message}`);
            continue;
          }
          const rec = await recordSurveyPhoto(id, leadId, category, path);
          if (!rec?.ok) {
            toast.error("Photo saved to storage but not recorded.");
            continue;
          }
          const { data: signed } = await supabase.storage
            .from(BUCKET)
            .createSignedUrl(path, 3600);
          setPhotos((prev) => [
            ...prev,
            {
              // No id returned by recordSurveyPhoto; generate a local key.
              // Delete still works because deleteSurveyPhoto keys off storage_path.
              id: crypto.randomUUID(),
              category,
              storage_path: path,
              url: signed?.signedUrl,
            },
          ]);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Upload error.");
        } finally {
          setUploading((u) => ({
            ...u,
            [category]: Math.max(0, u[category] - 1),
          }));
        }
      }
    },
    [ensureSurvey, leadId, supabase],
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

  // --- Mark complete.
  const onComplete = useCallback(async () => {
    setCompleting(true);
    const ok = await persist("completed");
    setCompleting(false);
    if (ok) {
      setCompleted(true);
      toast.success("Survey marked complete.");
    }
  }, [persist]);

  return (
    <div className="space-y-8">
      {/* ITEM CAPTURE */}
      <section className="space-y-6">
        {(Object.keys(grouped) as ("Boxes" | "Covers")[]).map((group) => (
          <div key={group} className="space-y-3">
            <h3 className="eyebrow text-mist-500">{group}</h3>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
              {grouped[group].map((field) => {
                const value = items[field.key];
                return (
                  <div
                    key={field.key}
                    className="flex items-center justify-between gap-3 bg-card px-4 py-3"
                  >
                    <span className="text-sm text-foreground">{field.label}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Decrease ${field.label}`}
                        className="size-11 rounded-md"
                        onClick={() => setQty(field.key, value - 1)}
                        disabled={value <= 0}
                      >
                        <Minus className="size-4" strokeWidth={1.75} />
                      </Button>
                      <span className="tabular w-10 text-center text-sm font-medium">
                        {value}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Increase ${field.label}`}
                        className="size-11 rounded-md"
                        onClick={() => setQty(field.key, value + 1)}
                      >
                        <Plus className="size-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="survey-access-notes">Access notes</Label>
            <textarea
              id="survey-access-notes"
              value={accessNotes}
              onChange={(e) => setAccessNotes(e.target.value)}
              rows={4}
              placeholder="Parking, stairs, lift, narrow doorways, long carries…"
              className="flex w-full rounded-md border bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none transition placeholder:text-mist-400 focus-visible:border-mm-red focus-visible:ring-[3px] focus-visible:ring-mm-red/20"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="survey-large-notes">
              Large items / extra packing notes
            </Label>
            <textarea
              id="survey-large-notes"
              value={largeItemsNotes}
              onChange={(e) => setLargeItemsNotes(e.target.value)}
              rows={4}
              placeholder="Pianos, safes, fragile or oversized items, dismantling needs…"
              className="flex w-full rounded-md border bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none transition placeholder:text-mist-400 focus-visible:border-mm-red focus-visible:ring-[3px] focus-visible:ring-mm-red/20"
            />
          </div>
        </div>
      </section>

      <Separator />

      {/* PHOTOS */}
      <section className="space-y-6">
        <div className="space-y-1">
          <h3 className="eyebrow text-mist-500">Photos</h3>
          <p className="text-sm text-mist-400">
            Tap a dropzone to open the camera, or drag images in.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {PHOTO_GROUPS.map(({ category, label }) => {
            const groupPhotos = photos.filter((p) => p.category === category);
            const busy = uploading[category];
            const inputId = `survey-upload-${category}`;
            return (
              <div key={category} className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor={inputId} className="text-sm">
                    {label}
                  </Label>
                  {busy > 0 && (
                    <span className="flex items-center gap-1.5 text-xs text-mist-400">
                      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
                      Uploading {busy}…
                    </span>
                  )}
                </div>

                <label
                  htmlFor={inputId}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(category);
                  }}
                  onDragLeave={() => setDragOver((c) => (c === category ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(null);
                    if (e.dataTransfer.files?.length) {
                      void uploadFiles(category, e.dataTransfer.files);
                    }
                  }}
                  className={cn(
                    "flex min-h-[88px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-card px-4 py-5 text-center transition",
                    dragOver === category
                      ? "border-mm-red bg-accent"
                      : "hover:bg-muted",
                  )}
                >
                  <Camera className="size-5 text-mist-400" strokeWidth={1.75} />
                  <span className="text-sm text-mist-500">
                    Tap to capture or add photos
                  </span>
                  <input
                    id={inputId}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void uploadFiles(category, e.target.files);
                      }
                      e.currentTarget.value = "";
                    }}
                  />
                </label>

                {groupPhotos.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {groupPhotos.map((photo) => (
                      <div
                        key={photo.id}
                        className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                      >
                        {photo.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={photo.url}
                            alt={`${label} survey photo`}
                            className="size-full object-cover"
                          />
                        ) : (
                          <div className="flex size-full items-center justify-center">
                            <Loader2
                              className="size-4 animate-spin text-mist-400"
                              strokeWidth={1.75}
                            />
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
          })}
        </div>
      </section>

      <Separator />

      {/* COMPLETE */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-mist-400">Changes save automatically.</p>
        <Button
          type="button"
          onClick={onComplete}
          disabled={completing}
          className="h-11 bg-mm-red text-white hover:bg-mm-red/90"
        >
          {completing ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
          ) : completed ? (
            <CheckCircle2 className="size-4" strokeWidth={1.75} />
          ) : null}
          {completed ? "Survey complete" : "Mark survey complete"}
        </Button>
      </div>
    </div>
  );
}
