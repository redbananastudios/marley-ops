"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Crew notes + photos on the job page (Peter, 2026-07-10): damage found,
 * access problems, anything worth an internal record. Photos upload straight
 * from the phone camera to the private job-photos bucket (same client-side
 * pattern as survey photos), then the note is saved server-side. Crew can
 * remove their own notes; the office sees everything on the lead page.
 */

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, NotebookPen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { JobNoteView } from "@/lib/job-notes";
import {
  addJobNoteAction,
  deleteJobNoteAction,
  discardJobPhotoAction,
} from "@/app/actions/job-notes";

const BUCKET = "job-photos";
const MAX_PHOTOS = 8;

interface PendingPhoto {
  path: string;
  previewUrl: string;
}

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });

export function JobNotes({
  appointmentId,
  notes,
  currentProfileId,
}: {
  appointmentId: string;
  notes: JobNoteView[];
  currentProfileId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [uploading, setUploading] = useState(0);
  const [saving, startSaving] = useTransition();
  const [removingId, setRemovingId] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (files: FileList) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!list.length) return;
      if (pending.length + list.length > MAX_PHOTOS) {
        toast.error(`Up to ${MAX_PHOTOS} photos per note.`);
        return;
      }
      setUploading((u) => u + list.length);
      for (const file of list) {
        try {
          const rawExt = (file.name.split(".").pop() || "jpg").toLowerCase();
          const ext = ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(rawExt) ? rawExt : "jpg";
          const path = `${appointmentId}/${crypto.randomUUID()}.${ext}`;
          const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
          if (error) {
            toast.error(`Upload failed: ${error.message}`);
            continue;
          }
          setPending((p) => [...p, { path, previewUrl: URL.createObjectURL(file) }]);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Upload error.");
        } finally {
          setUploading((u) => Math.max(0, u - 1));
        }
      }
    },
    [appointmentId, pending.length, supabase],
  );

  const removePending = useCallback(
    (photo: PendingPhoto) => {
      setPending((p) => p.filter((x) => x.path !== photo.path));
      URL.revokeObjectURL(photo.previewUrl);
      void discardJobPhotoAction(appointmentId, photo.path);
    },
    [appointmentId],
  );

  const save = useCallback(() => {
    if (!body.trim() && pending.length === 0) {
      toast.error("Write a note or add a photo first.");
      return;
    }
    startSaving(async () => {
      const res = await addJobNoteAction(appointmentId, {
        body,
        photoPaths: pending.map((p) => p.path),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setBody("");
      setPending([]);
      toast.success("Note saved — the office can see it.");
      router.refresh();
    });
  }, [appointmentId, body, pending, router]);

  const removeNote = useCallback(
    async (noteId: string) => {
      setRemovingId(noteId);
      const res = await deleteJobNoteAction(noteId);
      setRemovingId(null);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.refresh();
    },
    [router],
  );

  return (
    <div className="mt-3 rounded-lg border border-border bg-card">
      <div className="border-b px-4 py-3">
        <p className="eyebrow flex items-center gap-1.5">
          <NotebookPen className="size-3.5" strokeWidth={1.75} />
          Crew notes &amp; photos
        </p>
      </div>

      {/* existing notes */}
      {notes.length > 0 ? (
        <ul className="divide-y">
          {notes.map((n) => (
            <li key={n.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-mist-400">
                  {n.author_name} · {fmtAt(n.created_at)}
                </p>
                {n.author_id === currentProfileId ? (
                  <button
                    type="button"
                    aria-label="Remove note"
                    disabled={removingId === n.id}
                    onClick={() => void removeNote(n.id)}
                    className="focus-ring -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-mm-red"
                  >
                    {removingId === n.id ? (
                      <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <Trash2 className="size-4" strokeWidth={1.75} />
                    )}
                  </button>
                ) : null}
              </div>
              {n.body ? <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{n.body}</p> : null}
              {n.photos.length ? (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {n.photos.map((p) => (
                    <a key={p.path} href={p.url} target="_blank" rel="noreferrer">
                      <img
                        src={p.url}
                        alt="Crew photo"
                        className="aspect-square w-full rounded-md border border-border object-cover"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm text-mist-400">
          Nothing recorded yet. Note any damage, access issues or anything the office should know —
          photos go on the internal record, never to the customer.
        </p>
      )}

      {/* add form */}
      <div className="space-y-3 border-t px-4 py-4">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Add a note — damage, access problems, anything worth recording…"
          className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2.5 text-base text-foreground placeholder:text-mist-400 md:text-sm"
        />

        {pending.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {pending.map((p) => (
              <div key={p.path} className="relative aspect-square overflow-hidden rounded-md border bg-muted">
                <img src={p.previewUrl} alt="Photo to attach" className="size-full object-cover" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => removePending(p)}
                  className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-foreground/70 text-white backdrop-blur-sm hover:bg-mm-red"
                >
                  <X className="size-4" strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="focus-ring inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">
            <Camera className="size-4" strokeWidth={1.75} />
            Add photos
            <input
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
          <button
            type="button"
            onClick={save}
            disabled={saving || uploading > 0}
            className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-60"
          >
            {saving || uploading > 0 ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {uploading > 0 ? "Uploading…" : saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}
