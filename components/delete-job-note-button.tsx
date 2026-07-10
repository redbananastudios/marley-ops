"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteJobNoteAction } from "@/app/actions/job-notes";

/** Office-side removal of a crew note (author-side removal lives on the crew
 *  page). Confirms first — photos go with the note. */
export function DeleteJobNoteButton({ noteId }: { noteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label="Remove crew note"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Remove this crew note and its photos?")) return;
        setBusy(true);
        const res = await deleteJobNoteAction(noteId);
        setBusy(false);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        router.refresh();
      }}
      className="focus-ring -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-mm-red"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <Trash2 className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}
