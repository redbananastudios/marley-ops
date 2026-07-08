"use client";

/**
 * "View lead" on the quote builder — opens the lead's context in a modal instead of
 * navigating away, so the estimator never loses their place in the wizard. Shows the
 * shared Customer / Move / Notes panels plus the lead's status, with a new-tab link
 * to the full lead page for the rare deep-dive.
 */

import { useState } from "react";
import { ExternalLink, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LeadContextPanels, type LeadOption } from "@/components/schedule/appointment-dialog";

const STATUS_LABELS: Record<string, string> = {
  website_enquiry: "New enquiry",
  survey_booked: "Survey booked",
  quoted: "Quoted",
  provisional: "Provisional",
  confirmed: "Confirmed",
  completed: "Completed",
  declined: "Declined",
};

export function ViewLeadDialog({ lead, status }: { lead: LeadOption; status?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-mm-red/40 bg-mm-red-tint px-2.5 text-sm font-medium text-mm-red-deep transition-colors hover:bg-mm-red hover:text-white"
      >
        <Users className="size-4" strokeWidth={1.75} />
        View lead
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display">{lead.name ?? "Lead"}</DialogTitle>
            <DialogDescription>
              {status ? (STATUS_LABELS[status] ?? status) : "Lead details"} — the quote stays open behind this.
            </DialogDescription>
          </DialogHeader>

          <LeadContextPanels lead={lead} />

          <a
            href={`/leads/${lead.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1.5 self-start rounded-sm text-sm text-mist-400 transition-colors hover:text-foreground"
          >
            <ExternalLink className="size-4" strokeWidth={1.75} />
            Open the full lead page (new tab)
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}
