/* eslint-disable @next/next/no-img-element */
import { NotebookPen } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { JobNoteView } from "@/lib/job-notes";
import { DeleteJobNoteButton } from "@/components/delete-job-note-button";

/**
 * Office view of crew notes + photos (damage reports, access issues, internal
 * records) — rendered with the signed evidence on the lead and quote pages.
 * Internal-only: nothing here ever reaches the customer.
 */

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });

export function CrewNotesCard({ notes, canDelete = false }: { notes: JobNoteView[]; canDelete?: boolean }) {
  if (!notes.length) return null;
  return (
    <Card className="gap-2 p-5">
      <p className="eyebrow flex items-center gap-1.5">
        <NotebookPen className="size-3.5" strokeWidth={1.75} /> Crew notes
        <span className="font-normal normal-case tracking-normal text-mist-400">— internal, never sent to the customer</span>
      </p>
      <ul className="divide-y">
        {notes.map((n) => (
          <li key={n.id} className="py-3 first:pt-1 last:pb-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-mist-400">
                {n.author_name} · {fmtAt(n.created_at)}
              </p>
              {canDelete ? <DeleteJobNoteButton noteId={n.id} /> : null}
            </div>
            {n.body ? <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{n.body}</p> : null}
            {n.photos.length ? (
              <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                {n.photos.map((p) => (
                  <a key={p.path} href={p.url} target="_blank" rel="noreferrer">
                    <img
                      src={p.url}
                      alt={`Crew photo from ${n.author_name}`}
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
    </Card>
  );
}
