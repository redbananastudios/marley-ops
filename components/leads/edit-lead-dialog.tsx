"use client";

/**
 * Edit a lead's customer + move details in one dialog. Covers contact, the full
 * pickup/destination addresses (which the website never sends but the firm quote
 * needs), the recorded phone estimate, and notes. Saving keeps the linked client
 * record aligned so the correction shows everywhere.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, MapPin } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddressFields, BLANK_ADDRESS, type AddressValue } from "@/components/places/address-fields";
import { WindowTierPicker } from "@/components/bookings/window-tier-picker";
import { MonthSelect } from "@/components/bookings/month-select";
import { updateLeadDetailsAction } from "@/app/(dashboard)/leads/actions";
import { PROPERTY_SIZES, type EditLeadInput } from "@/lib/leads/schema";

export interface EditLeadValues {
  name: string;
  phone: string;
  email: string;
  from_postcode: string;
  to_postcode: string;
  from_address: string;
  to_address: string;
  property_size: string;
  to_property_size: string;
  preferred_date: string;
  /** Provisional window ("YYYY-MM" + early/mid/late) — booking_details, not lead columns. */
  approx_month: string;
  approx_window: string;
  estimate_given: string;
  referral_commission: string;
  notes: string;
}

const textarea =
  "border-input placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

/** Build a structured address from the lead's stored line + postcode. */
function seedAddress(line: string, postcode: string): AddressValue {
  return { ...BLANK_ADDRESS, line1: line || "", postcode: postcode || "" };
}
/** The street part (line1 + town + county) stored back into the lead's *_address column. */
function streetPart(a: AddressValue): string {
  return [a.line1, a.town, a.county].filter((s) => s && s.trim()).join(", ").trim();
}

/** Property-size dropdown — one per end of the move, same options both ends. */
function SizeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (val: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Property size</Label>
      <Select value={value || ""} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-11">
          <SelectValue placeholder="Select size" />
        </SelectTrigger>
        <SelectContent>
          {/* Preserve a pre-existing free-text value that isn't in the list. */}
          {value && !PROPERTY_SIZES.includes(value as (typeof PROPERTY_SIZES)[number]) ? (
            <SelectItem value={value}>{value}</SelectItem>
          ) : null}
          {PROPERTY_SIZES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function EditLeadDialog({ leadId, initial }: { leadId: string; initial: EditLeadValues }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<EditLeadValues>(initial);
  const [fromAddr, setFromAddr] = useState<AddressValue>(seedAddress(initial.from_address, initial.from_postcode));
  const [toAddr, setToAddr] = useState<AddressValue>(seedAddress(initial.to_address, initial.to_postcode));

  // Reseed from the latest server data each time it opens.
  useEffect(() => {
    if (open) {
      setV(initial);
      setFromAddr(seedAddress(initial.from_address, initial.from_postcode));
      setToAddr(seedAddress(initial.to_address, initial.to_postcode));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: keyof EditLeadValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  // Structured address → the lead's line + postcode columns (kept in step).
  const onFromChange = (a: AddressValue) => {
    setFromAddr(a);
    setV((s) => ({ ...s, from_address: streetPart(a), from_postcode: a.postcode }));
  };
  const onToChange = (a: AddressValue) => {
    setToAddr(a);
    setV((s) => ({ ...s, to_address: streetPart(a), to_postcode: a.postcode }));
  };

  async function onSave() {
    setBusy(true);
    try {
      const res = await updateLeadDetailsAction(leadId, v as unknown as EditLeadInput);
      if (!res.ok) {
        toast.error(res.error || "Could not save.");
        return;
      }
      // A save can succeed while deliberately doing less than the office would
      // assume — when other enquiries share this customer, the shared customer
      // record is left alone. That has to read differently from a plain success,
      // and stay up long enough to be read.
      if (res.warning) toast.warning(res.warning, { duration: 12000 });
      else toast.success("Lead updated.");
      setOpen(false);
      router.refresh();
    } catch {
      // A THROWN action (vs a returned error) most often means the app was
      // redeployed after this tab loaded — the stale bundle calls a server
      // action id that no longer exists. Without this catch the save failed in
      // total silence (Stephen Bull postcode edit, 2026-08-14).
      toast.error("Could not save — the app may have just updated. Refresh the page and try again.");
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

          {/* Pickup */}
          <div className="grid gap-3 border-t pt-4">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-mm-red">
              <MapPin className="size-4" strokeWidth={1.75} />
              Pickup
            </p>
            <AddressFields value={fromAddr} onChange={onFromChange} idPrefix="ed-from" />
            <SizeSelect
              id="ed-size"
              value={v.property_size}
              onChange={(val) => setV((s) => ({ ...s, property_size: val }))}
            />
          </div>

          {/* Destination */}
          <div className="grid gap-3 border-t pt-4">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-mm-red">
              <MapPin className="size-4" strokeWidth={1.75} />
              Destination
            </p>
            <AddressFields value={toAddr} onChange={onToChange} idPrefix="ed-to" />
            <SizeSelect
              id="ed-to-size"
              value={v.to_property_size}
              onChange={(val) => setV((s) => ({ ...s, to_property_size: val }))}
            />
          </div>

          {/* Move date — confirmed only when the customer has named a firm date;
              otherwise the provisional Beginning/Middle/End window. */}
          <div className="grid gap-3 border-t pt-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Move date</p>
              <p className="mt-1 text-xs text-mist-400">
                Confirmed = the customer has named a firm date (it flows into the quote and the
                payment steps). Website enquiries arrive with the customer&apos;s own anticipated
                date — check it on the first call or move it to a provisional window.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="ed-date">Confirmed date</Label>
                <Input id="ed-date" type="date" value={v.preferred_date} onChange={set("preferred_date")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ed-approx-month">Provisional month</Label>
                <MonthSelect
                  id="ed-approx-month"
                  className="h-11"
                  value={v.approx_month}
                  onChange={(val) => setV((s) => ({ ...s, approx_month: val }))}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ed-window-early">Part of the month</Label>
              <WindowTierPicker
                idPrefix="ed-window"
                value={v.approx_window}
                onChange={(tier) => setV((s) => ({ ...s, approx_window: tier }))}
              />
            </div>
          </div>

          <div className="grid gap-2 border-t pt-4">
            <Label htmlFor="ed-est">Estimate given (£)</Label>
            <Input id="ed-est" type="number" inputMode="decimal" min={0} value={v.estimate_given} onChange={set("estimate_given")} placeholder="e.g. 950" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ed-commission">3rd-party commission (£)</Label>
            <Input
              id="ed-commission"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={v.referral_commission}
              onChange={set("referral_commission")}
              placeholder="e.g. 50"
            />
            <p className="text-xs text-mist-400">
              Fee owed to a third party for this lead — counted as a job cost in profit and margin reports.
            </p>
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
