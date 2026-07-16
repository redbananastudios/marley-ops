"use client";

/** "Open a claim" from the lead page — how it was reported + what's claimed.
 *  Lands on the new claim's page so the office finishes the record in one go. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { openClaimAction } from "@/app/actions/claims";
import { CLAIM_CHANNEL_LABEL, MANUAL_CLAIM_CHANNELS, type ClaimChannel } from "@/lib/claims";

export function OpenClaimDialog({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<ClaimChannel>("phone");
  const [description, setDescription] = useState("");

  async function submit() {
    setBusy(true);
    let res: Awaited<ReturnType<typeof openClaimAction>>;
    try {
      res = await openClaimAction(leadId, { channel, description });
    } catch {
      // A dropped request throws instead of returning ok:false; busy must
      // reset or every exit from the dialog stays blocked.
      setBusy(false);
      toast.error("No signal — try again.");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not open the claim.");
      return;
    }
    toast.success(`Claim ${res.ref} opened.`);
    setOpen(false);
    router.push(`/claims/${res.claimId}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't drop a typed description on a stray backdrop tap.
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <ShieldAlert className="size-4" strokeWidth={1.75} />
          Open a claim
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          // A typed description must never be lost to a stray backdrop tap.
          if (busy || description.trim()) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display">Open a claim</DialogTitle>
          <DialogDescription>
            Starts the claim record — status trail, resolution and the evidence pack live on the
            Claims page.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="claim-channel">How was it reported?</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as ClaimChannel)}>
              <SelectTrigger id="claim-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_CLAIM_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CLAIM_CHANNEL_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="claim-description">What are they claiming for?</Label>
            <textarea
              id="claim-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What was damaged or went wrong, in the customer's words"
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-10">
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || description.trim().length < 5} className="h-10">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Open claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
