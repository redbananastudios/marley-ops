"use client";

/**
 * The claim's working card: status trail, resolution + amount when it ends,
 * insurer reference + notified stamp, running notes. One Save — the server
 * action validates with the same lib/claims rules the form previews.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateClaimAction } from "@/app/actions/claims";
import {
  CLAIM_RESOLUTION_LABEL,
  CLAIM_RESOLUTIONS,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUSES,
  isOpenClaimStatus,
  type ClaimResolution,
  type ClaimStatus,
} from "@/lib/claims";

export interface ClaimFormState {
  status: ClaimStatus;
  resolution: ClaimResolution | null;
  resolutionAmount: number | null;
  insurerRef: string;
  insurerNotified: boolean;
  notes: string;
}

export function ClaimUpdateForm({ claimId, initial }: { claimId: string; initial: ClaimFormState }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ClaimStatus>(initial.status);
  const [resolution, setResolution] = useState<ClaimResolution | null>(initial.resolution);
  const [amount, setAmount] = useState(
    initial.resolutionAmount != null ? String(initial.resolutionAmount) : "",
  );
  const [insurerRef, setInsurerRef] = useState(initial.insurerRef);
  const [insurerNotified, setInsurerNotified] = useState(initial.insurerNotified);
  const [notes, setNotes] = useState(initial.notes);

  const terminal = !isOpenClaimStatus(status);
  const amountNumber = useMemo(() => {
    const trimmed = amount.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : Number.NaN;
  }, [amount]);

  async function save() {
    if (terminal && !resolution) {
      toast.error("Pick how the claim ended before closing it.");
      return;
    }
    if (amountNumber != null && Number.isNaN(amountNumber)) {
      toast.error("The amount doesn't look right — enter pounds, no symbols.");
      return;
    }
    setBusy(true);
    const res = await updateClaimAction(claimId, {
      status,
      resolution: terminal ? resolution : null,
      resolutionAmount: terminal ? amountNumber : null,
      insurerRef,
      insurerNotified,
      notes,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not save the claim.");
      return;
    }
    toast.success("Claim saved.");
    router.refresh();
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="claim-status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as ClaimStatus)}>
            <SelectTrigger id="claim-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLAIM_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {CLAIM_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {terminal ? (
          <div className="grid gap-2">
            <Label htmlFor="claim-resolution">How did it end?</Label>
            <Select
              value={resolution ?? ""}
              onValueChange={(v) => setResolution(v as ClaimResolution)}
            >
              <SelectTrigger id="claim-resolution">
                <SelectValue placeholder="Pick the outcome" />
              </SelectTrigger>
              <SelectContent>
                {CLAIM_RESOLUTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {CLAIM_RESOLUTION_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {terminal ? (
        <div className="grid gap-2 sm:max-w-[240px]">
          <Label htmlFor="claim-amount">
            Amount (£){resolution === "goodwill_payment" ? " — required" : " — if any"}
          </Label>
          <Input
            id="claim-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="claim-insurer-ref">Insurer reference</Label>
          <Input
            id="claim-insurer-ref"
            value={insurerRef}
            onChange={(e) => setInsurerRef(e.target.value)}
            placeholder="Policy / claim number"
          />
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 self-end rounded-md border border-input bg-card px-3 py-2">
          <input
            type="checkbox"
            checked={insurerNotified}
            onChange={(e) => setInsurerNotified(e.target.checked)}
            className="size-4 accent-mm-red"
          />
          <span className="text-sm text-foreground">Insurer notified</span>
        </label>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="claim-notes">Notes (internal)</Label>
        <textarea
          id="claim-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Calls made, what was agreed, what's outstanding"
          className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm"
        />
      </div>

      <div>
        <Button onClick={save} disabled={busy} className="h-10">
          {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
          Save claim
        </Button>
      </div>
    </div>
  );
}
