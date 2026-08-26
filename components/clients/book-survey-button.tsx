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
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { MANUAL_ENTRY_CHANNELS } from "@/lib/leads/schema";
import { createLeadForClientAction } from "@/app/(dashboard)/clients/actions";

/** The brand picker's option shape — `listActiveBrands()` rows satisfy it.
 *  Entirely data-driven: labels come from the brands table, never from code
 *  (mirrors ApptBrandOption on the diary dialog, gate 11). */
export interface BookSurveyBrandOption {
  slug: string;
  name: string;
  shortName?: string | null;
}

export function BookSurveyButton({
  clientId,
  openLeadId,
  className,
  brands = [],
}: {
  clientId: string;
  /** The client's live enquiry, when they have one — skips the source dialog. */
  openLeadId?: string | null;
  className?: string;
  /** GATE 11: active brands (multi-brand PRD §2 "Manual leads: brand required").
   *  Two or more → a REQUIRED segmented brand picker (no default) renders in the
   *  source dialog — this button opens an enquiry, and nothing says which brand
   *  a phone customer rang. Fewer (the single-brand invariant, PRD §1) → nothing
   *  renders, no brand is sent and the server writes DEFAULT_BRAND silently. */
  brands?: BookSurveyBrandOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState("phone_google");
  // GATE 11: brand for the enquiry this opens. Deliberately NO default in
  // multi-brand mode (mirrors /leads/new, gate 5) — the office must say which
  // brand the customer rang. Empty string = not picked yet.
  const [brand, setBrand] = useState("");
  const [brandError, setBrandError] = useState<string | null>(null);
  const requireBrand = brands.length > 1;

  function start() {
    if (openLeadId) {
      router.push(`/schedule/surveys?leadId=${openLeadId}`);
      return;
    }
    setOpen(true);
  }

  async function createAndGo() {
    // GATE 11: cannot submit until a brand is picked (multi-brand only — the
    // server re-validates regardless). Single-brand sends no brand at all.
    if (requireBrand && !brand) {
      setBrandError("Choose which brand this enquiry is for.");
      return;
    }
    setBusy(true);
    try {
      const res = await createLeadForClientAction(clientId, channel, requireBrand ? brand : undefined);
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

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // A brand pick belongs to the visit it was made for — never carry it
          // (or its error) into a later open.
          if (!o) {
            setBrand("");
            setBrandError(null);
          }
        }}
      >
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
          {/* GATE 11: this booking OPENS an enquiry, and in multi-brand mode
              nothing says which brand the customer rang — so the pick is
              REQUIRED, with deliberately NO default (mirrors /leads/new,
              gate 5). Options are data-driven from the brands table; renders
              only in multi-brand mode (see the `brands` prop). */}
          {requireBrand ? (
            <div className="grid gap-2 pb-2">
              <Label>
                Brand <span className="text-mm-red">*</span>
              </Label>
              <div role="group" aria-label="Brand" data-testid="brand-picker" className={segmentedTrackClass}>
                {brands.map((b) => (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => {
                      setBrand(b.slug);
                      setBrandError(null);
                    }}
                    aria-pressed={brand === b.slug}
                    data-brand={b.slug}
                    className={segmentedItemClass(brand === b.slug)}
                  >
                    {b.shortName ?? b.name}
                  </button>
                ))}
              </div>
              {brandError ? <p className="text-xs text-destructive">{brandError}</p> : null}
            </div>
          ) : null}
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
