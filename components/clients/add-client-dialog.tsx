"use client";

/**
 * Add a client directly (manual entry). Mirrors the agreed form: company toggle,
 * split name, primary + secondary emails, phone + alternate, and the shared structured
 * address block (Google street + postcode lookup). Dedupes on phone/primary email as you
 * go — if the person already exists it attaches rather than duplicating.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, TriangleAlert, X, MapPin, Building2 } from "lucide-react";
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
import { MANUAL_ENTRY_CHANNELS } from "@/lib/leads/schema";
import {
  createClientAction,
  checkClientDuplicateAction,
  createLeadForClientAction,
} from "@/app/(dashboard)/clients/actions";

interface Values {
  isCompany: boolean;
  companyName: string;
  businessNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  altPhone: string;
  notes: string;
}

const EMPTY: Values = {
  isCompany: false,
  companyName: "",
  businessNumber: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  altPhone: "",
  notes: "",
};

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export function AddClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Values>(EMPTY);
  const [address, setAddress] = useState<AddressValue>(BLANK_ADDRESS);
  const [secondaryEmails, setSecondaryEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState("");
  const [dupe, setDupe] = useState<{ clientName: string | null; previousLeadCount: number } | null>(null);
  // Post-save step: offer the survey booking straight away (phone callers'
  // usual next move) instead of dumping the user on the client page.
  const [saved, setSaved] = useState<{ clientId: string; matched: boolean } | null>(null);
  const [channel, setChannel] = useState("phone_google");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  function reset() {
    setV(EMPTY);
    setAddress(BLANK_ADDRESS);
    setSecondaryEmails([]);
    setEmailDraft("");
    setDupe(null);
    setSaved(null);
    setChannel("phone_google");
  }

  function commitSecondaryEmail() {
    const e = emailDraft.trim().toLowerCase();
    if (!e) return;
    if (!isEmail(e)) {
      toast.error("That doesn't look like an email.");
      return;
    }
    if (e === v.email.trim().toLowerCase() || secondaryEmails.includes(e)) {
      setEmailDraft("");
      return;
    }
    setSecondaryEmails((s) => [...s, e]);
    setEmailDraft("");
  }

  const runDedupe = useCallback(async () => {
    const { phone, email } = v;
    if (!phone && !email) {
      setDupe(null);
      return;
    }
    try {
      const res = await checkClientDuplicateAction({ phone: phone || undefined, email: email || undefined });
      setDupe(res.matched ? { clientName: res.clientName, previousLeadCount: res.previousLeadCount } : null);
    } catch {
      /* advisory only */
    }
  }, [v]);

  const onDedupeBlur = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(runDedupe, 300);
  }, [runDedupe]);

  async function onSave() {
    if (!v.firstName.trim() && !v.companyName.trim()) {
      toast.error(v.isCompany ? "Add a company or contact name." : "Add a first name.");
      return;
    }
    if (v.email && !isEmail(v.email)) {
      toast.error("Primary email looks invalid.");
      return;
    }
    setBusy(true);
    try {
      const res = await createClientAction({
        isCompany: v.isCompany,
        companyName: v.companyName || undefined,
        businessNumber: v.businessNumber || undefined,
        firstName: v.firstName || undefined,
        lastName: v.lastName || undefined,
        email: v.email || undefined,
        secondaryEmails,
        phone: v.phone || undefined,
        altPhone: v.altPhone || undefined,
        address,
        notes: v.notes || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.matched ? "Matched an existing client." : "Client added.");
      // Stay in the dialog: step 2 offers the survey booking immediately.
      setSaved({ clientId: res.clientId, matched: res.matched });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function bookSurvey() {
    if (!saved) return;
    setBusy(true);
    try {
      const res = await createLeadForClientAction(saved.clientId, channel);
      if (!res.ok) {
        toast.error(res.error || "Could not open an enquiry.");
        return;
      }
      setOpen(false);
      reset();
      router.push(`/schedule/surveys?leadId=${res.leadId}`);
    } finally {
      setBusy(false);
    }
  }

  function goToClient() {
    if (!saved) return;
    const id = saved.clientId;
    setOpen(false);
    reset();
    router.push(`/clients/${id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="h-9">
          <Plus strokeWidth={1.75} />
          Add client
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto sm:max-w-lg">
        {saved ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">
                {saved.matched ? "Matched an existing client" : "Client added"}
              </DialogTitle>
              <DialogDescription>
                Book their survey now? Pick where the call came from and we&apos;ll open the
                enquiry and take you straight to the diary.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor="ac-channel">How did they get in touch?</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger id="ac-channel">
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
              <Button variant="outline" onClick={goToClient} disabled={busy} className="h-11">
                Not now — open client
              </Button>
              <Button onClick={bookSurvey} disabled={busy} className="h-11">
                {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
                Book survey
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
        <DialogHeader>
          <DialogTitle className="font-display">Add client</DialogTitle>
          <DialogDescription>A person or household. We check for an existing match on phone or email.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-3">
          {/* company toggle */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3.5 py-2.5">
            <input
              type="checkbox"
              checked={v.isCompany}
              onChange={(e) => setV((s) => ({ ...s, isCompany: e.target.checked }))}
              className="size-4 accent-mm-red"
            />
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Building2 className="size-4 text-mist-400" strokeWidth={1.75} />
              Is this client a company?
            </span>
          </label>

          {v.isCompany ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="ac-company">Company name</Label>
                <Input id="ac-company" value={v.companyName} onChange={set("companyName")} placeholder="Company name" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ac-bizno">Business number</Label>
                <Input id="ac-bizno" value={v.businessNumber} onChange={set("businessNumber")} placeholder="Company no." />
              </div>
            </div>
          ) : null}

          {/* name */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ac-first">
                First name {!v.isCompany ? <span className="text-mm-red">*</span> : null}
              </Label>
              <Input id="ac-first" value={v.firstName} onChange={set("firstName")} placeholder="First name" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ac-last">Last name</Label>
              <Input id="ac-last" value={v.lastName} onChange={set("lastName")} placeholder="Last name" />
            </div>
          </div>

          {/* primary email */}
          <div className="grid gap-2">
            <Label htmlFor="ac-email">Primary email</Label>
            <Input id="ac-email" type="email" value={v.email} onChange={set("email")} onBlur={onDedupeBlur} placeholder="name@example.com" />
          </div>

          {/* secondary emails (chips) */}
          <div className="grid gap-2">
            <Label htmlFor="ac-email2">Secondary emails</Label>
            {secondaryEmails.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {secondaryEmails.map((e) => (
                  <span key={e} className="inline-flex items-center gap-1 rounded-pill bg-muted px-2 py-0.5 text-xs text-mist-500">
                    {e}
                    <button
                      type="button"
                      onClick={() => setSecondaryEmails((s) => s.filter((x) => x !== e))}
                      aria-label={`Remove ${e}`}
                      className="text-mist-400 hover:text-danger"
                    >
                      <X className="size-3" strokeWidth={2} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <Input
              id="ac-email2"
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  commitSecondaryEmail();
                }
              }}
              onBlur={commitSecondaryEmail}
              placeholder="Press Enter to add another email"
            />
          </div>

          {/* phones */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ac-phone">Phone number</Label>
              <Input id="ac-phone" type="tel" value={v.phone} onChange={set("phone")} onBlur={onDedupeBlur} placeholder="07…" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ac-altphone">Alternate phone</Label>
              <Input id="ac-altphone" type="tel" value={v.altPhone} onChange={set("altPhone")} placeholder="Alternate phone" />
            </div>
          </div>

          {/* address */}
          <div className="border-t pt-4">
            <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-mm-red">
              <MapPin className="size-4" strokeWidth={1.75} />
              Address
            </p>
            <AddressFields value={address} onChange={setAddress} idPrefix="ac-addr" />
          </div>

          {/* notes */}
          <div className="grid gap-2">
            <Label htmlFor="ac-notes">Notes</Label>
            <textarea
              id="ac-notes"
              value={v.notes}
              onChange={set("notes")}
              rows={3}
              placeholder="Any notes about this client…"
              className="focus-ring min-h-[72px] w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-mist-400"
            />
          </div>

          {dupe ? (
            <div className="flex items-start gap-2.5 rounded-md border border-warn-border bg-warn-bg px-3.5 py-3 text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
              <p className="text-sm leading-snug">
                Matches existing client <span className="font-semibold">{dupe.clientName ?? "an existing client"}</span> —{" "}
                {dupe.previousLeadCount} {dupe.previousLeadCount === 1 ? "enquiry" : "enquiries"}. Saving will open them
                rather than create a duplicate.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-11">
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Add client
          </Button>
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
