"use client";

/**
 * "Book survey" from a client record. Phone callers become clients first, but a
 * booking needs a lead — this jumps straight to the survey diary when the client
 * already has an open enquiry, otherwise asks where the call came from (the
 * phone source feeds attribution) and opens the enquiry before navigating.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MANUAL_ENTRY_CHANNELS } from "@/lib/leads/schema";
import { createLeadForClientAction } from "@/app/(dashboard)/clients/actions";

export function BookSurveyButton({
  clientId,
  openLeadId,
  className,
}: {
  clientId: string;
  /** The client's live enquiry, when they have one — skips the source dialog. */
  openLeadId?: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState("phone_google");

  function start() {
    if (openLeadId) {
      router.push(`/schedule/surveys?leadId=${openLeadId}`);
      return;
    }
    setOpen(true);
  }

  async function createAndGo() {
    setBusy(true);
    try {
      const res = await createLeadForClientAction(clientId, channel);
      if (!res.ok) {
        toast.error(res.error || "Could not open an enquiry for this client.");
        return;
      }
      if (!res.created) toast.info("Using their existing open enquiry.");
      setOpen(false);
      router.push(`/schedule/surveys?leadId=${res.leadId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        className={
          className ??
          "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:brightness-95"
        }
      >
        <CalendarPlus className="size-4" strokeWidth={2} />
        Book survey
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Book survey</DialogTitle>
            <DialogDescription>
              This opens an enquiry for the client (bookings live on enquiries) and takes you to
              the survey diary with them preselected.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="bs-channel">How did they get in touch?</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger id="bs-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_ENTRY_CHANNELS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-11">
              Cancel
            </Button>
            <Button onClick={createAndGo} disabled={busy} className="h-11">
              {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <CalendarPlus className="size-4" strokeWidth={1.75} />}
              To the diary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
