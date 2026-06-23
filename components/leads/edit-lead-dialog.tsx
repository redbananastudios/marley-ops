"use client";

/**
 * Edit a lead's customer + move details in one dialog. Covers contact, the full
 * pickup/destination addresses (which the website never sends but the firm quote
 * needs), the recorded phone estimate, and notes. Saving keeps the linked client
 * record aligned so the correction shows everywhere.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateLeadDetailsAction } from "@/app/(dashboard)/leads/actions";
import type { EditLeadInput } from "@/lib/leads/schema";

export interface EditLeadValues {
  name: string;
  phone: string;
  email: string;
  from_postcode: string;
  to_postcode: string;
  from_address: string;
  to_address: string;
  property_size: string;
  preferred_date: string;
  estimate_given: string;
  notes: string;
}

const textarea =
  "border-input placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function EditLeadDialog({ leadId, initial }: { leadId: string; initial: EditLeadValues }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<EditLeadValues>(initial);

  // Reseed from the latest server data each time it opens.
  useEffect(() => {
    if (open) setV(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: keyof EditLeadValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  async function onSave() {
    setBusy(true);
    try {
      const res = await updateLeadDetailsAction(leadId, v as unknown as EditLeadInput);
      if (!res.ok) {
        toast.error(res.error || "Could not save.");
        return;
      }
      toast.success("Lead updated.");
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <Pencil className="size-4" strokeWidth={1.75} />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Edit lead</DialogTitle>
          <DialogDescription>
            Customer details and the move. Full addresses prefill the survey and quote.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] gap-4 overflow-y-auto py-1 pr-1">
          <div className="grid gap-2">
            <Label htmlFor="ed-name">Name</Label>
            <Input id="ed-name" value={v.name} onChange={set("name")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ed-phone">Phone</Label>
              <Input id="ed-phone" value={v.phone} onChange={set("phone")} placeholder="07…" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ed-email">Email</Label>
              <Input id="ed-email" type="email" value={v.email} onChange={set("email")} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ed-faddr">Pickup address</Label>
            <Input id="ed-faddr" value={v.from_address} onChange={set("from_address")} placeholder="House, street, town" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1 grid gap-2">
              <Label htmlFor="ed-fpc">Pickup postcode</Label>
              <Input id="ed-fpc" value={v.from_postcode} onChange={set("from_postcode")} />
            </div>
            <div className="col-span-2 grid gap-2">
              <Label htmlFor="ed-taddr">Destination address</Label>
              <Input id="ed-taddr" value={v.to_address} onChange={set("to_address")} placeholder="House, street, town" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ed-tpc">Destination postcode</Label>
            <Input id="ed-tpc" value={v.to_postcode} onChange={set("to_postcode")} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ed-size">Property size</Label>
              <Input id="ed-size" value={v.property_size} onChange={set("property_size")} placeholder="3-bed" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ed-date">Preferred date</Label>
              <Input id="ed-date" type="date" value={v.preferred_date} onChange={set("preferred_date")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ed-est">Estimate given (£)</Label>
              <Input id="ed-est" type="number" inputMode="decimal" min={0} value={v.estimate_given} onChange={set("estimate_given")} placeholder="e.g. 950" />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ed-notes">Notes</Label>
            <textarea id="ed-notes" rows={3} className={textarea} value={v.notes} onChange={set("notes")} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-11">
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
