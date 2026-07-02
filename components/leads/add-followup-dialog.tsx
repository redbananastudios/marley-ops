"use client";

/** Quick "Add follow-up" from the lead header — reason + due date + note. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createFollowUpAction, type FollowUpReason } from "@/app/(dashboard)/follow-ups/actions";

const REASONS: { value: FollowUpReason; label: string }[] = [
  { value: "no_answer", label: "No answer — retry" },
  { value: "quote_followup", label: "Quote follow-up" },
  { value: "deposit", label: "Deposit chase" },
  { value: "balance", label: "Balance chase" },
  { value: "custom", label: "Custom" },
];

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function AddFollowUpDialog({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<FollowUpReason>("custom");
  const [due, setDue] = useState(tomorrow());
  const [notes, setNotes] = useState("");

  async function submit() {
    setBusy(true);
    const res = await createFollowUpAction({ leadId, reason, dueAt: `${due}T09:00:00`, notes });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not create the follow-up.");
      return;
    }
    toast.success("Follow-up queued.");
    setOpen(false);
    setNotes("");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <BellRing className="size-4" strokeWidth={1.75} />
          Add follow-up
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Add follow-up</DialogTitle>
          <DialogDescription>Queues a task on the Follow-ups page.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="fu-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as FollowUpReason)}>
                <SelectTrigger id="fu-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fu-due">Due</Label>
              <Input id="fu-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fu-notes">Note (optional)</Label>
            <Input id="fu-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What needs doing" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-10">
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !due} className="h-10">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Queue it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
