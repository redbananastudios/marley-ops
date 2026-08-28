"use client";

/**
 * Edit an existing client + archive/restore control for the client detail page.
 * Reuses the exact field set of the Add-client dialog (company toggle, split name,
 * primary + secondary emails, phone + alternate, shared structured address, notes)
 * but prefilled from the record and wired to updateClientAction. Archiving is
 * admin-only and money-aware server-side — the action refuses while a live enquiry
 * or accepted quote hangs off the client, and we surface that as a toast.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, X, MapPin, Building2, Archive, ArchiveRestore } from "lucide-react";
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
import { PAYMENT_TERMS_DAY_OPTIONS, DEFAULT_PAYMENT_TERMS_DAYS } from "@/lib/payments-policy";
import { AddressFields, BLANK_ADDRESS, type AddressValue } from "@/components/places/address-fields";
import { updateClientAction, setClientActiveAction } from "@/app/(dashboard)/clients/actions";

export interface EditableClient {
  id: string;
  is_company: boolean | null;
  payment_terms_days: number | null;
  company_name: string | null;
  business_number: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  secondary_emails: string[] | null;
  phone_raw: string | null;
  phone_e164: string | null;
  alt_phone: string | null;
  address_line1: string | null;
  town: string | null;
  county: string | null;
  postcode_home: string | null;
  country: string | null;
  notes: string | null;
  is_active: boolean | null;
}

interface Values {
  isCompany: boolean;
  paymentTermsDays: number;
  companyName: string;
  businessNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  altPhone: string;
  notes: string;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function valuesFrom(c: EditableClient): Values {
  return {
    isCompany: !!c.is_company,
    paymentTermsDays: c.payment_terms_days ?? DEFAULT_PAYMENT_TERMS_DAYS,
    companyName: c.company_name ?? "",
    businessNumber: c.business_number ?? "",
    firstName: c.first_name ?? "",
    lastName: c.last_name ?? "",
    email: c.email ?? "",
    phone: c.phone_raw ?? c.phone_e164 ?? "",
    altPhone: c.alt_phone ?? "",
    notes: c.notes ?? "",
  };
}

function addressFrom(c: EditableClient): AddressValue {
  return {
    line1: c.address_line1 ?? "",
    town: c.town ?? "",
    county: c.county ?? "",
    postcode: c.postcode_home ?? "",
    country: c.country ?? BLANK_ADDRESS.country,
  };
}

/** Edit + Archive/Restore controls for the client header action bar. Archive shows
 *  to admins only (the server action gates it too); everyone can edit. */
export function ClientEditControls({ client, isAdmin }: { client: EditableClient; isAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Values>(() => valuesFrom(client));
  const [address, setAddress] = useState<AddressValue>(() => addressFrom(client));
  const [secondaryEmails, setSecondaryEmails] = useState<string[]>(() =>
    (client.secondary_emails ?? []).filter(Boolean),
  );
  const [emailDraft, setEmailDraft] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archivePending, startArchive] = useTransition();

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  // Reseed the form from the record whenever the dialog opens (the row can change
  // between edits via router.refresh()).
  function openDialog(o: boolean) {
    if (o) {
      setV(valuesFrom(client));
      setAddress(addressFrom(client));
      setSecondaryEmails((client.secondary_emails ?? []).filter(Boolean));
      setEmailDraft("");
    }
    setOpen(o);
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
      const res = await updateClientAction(client.id, {
        isCompany: v.isCompany,
        paymentTermsDays: v.paymentTermsDays,
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
      toast.success("Client updated.");
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function toggleActive() {
    const archiving = client.is_active !== false;
    startArchive(async () => {
      const res = await setClientActiveAction(client.id, !archiving);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(archiving ? "Client archived." : "Client restored.");
      setConfirmArchive(false);
      router.refresh();
    });
  }

  const archived = client.is_active === false;

  return (
    <>
      <Dialog open={open} onOpenChange={openDialog}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Pencil className="size-4 text-mist-400" strokeWidth={1.75} />
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Edit client</DialogTitle>
            <DialogDescription>Update this client&apos;s contact details and address.</DialogDescription>
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
              <span className="text-sm font-medium text-foreground">
                <span className="flex items-center gap-1.5">
                  <Building2 className="size-4 text-mist-400" strokeWidth={1.75} />
                  Commercial client — invoiced on account
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  Commercial bookings skip the deposit and the 25% commitment. One invoice is
                  raised when the job completes, due on the terms below, and the customer is
                  never chased automatically. Bookings already accepted keep the schedule they
                  were accepted on.
                </span>
              </span>
            </label>

            {v.isCompany ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="ec-company">Company name</Label>
                  <Input id="ec-company" value={v.companyName} onChange={set("companyName")} placeholder="Company name" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ec-bizno">Business number</Label>
                  <Input id="ec-bizno" value={v.businessNumber} onChange={set("businessNumber")} placeholder="Company no." />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ec-terms">Payment terms</Label>
                  <select
                    id="ec-terms"
                    value={v.paymentTermsDays}
                    onChange={(e) => setV((s) => ({ ...s, paymentTermsDays: Number(e.target.value) }))}
                    className="focus-ring h-11 rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    {PAYMENT_TERMS_DAY_OPTIONS.map((d) => (
                      <option key={d} value={d}>{d} days</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}

            {/* name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="ec-first">
                  First name {!v.isCompany ? <span className="text-mm-red">*</span> : null}
                </Label>
                <Input id="ec-first" value={v.firstName} onChange={set("firstName")} placeholder="First name" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ec-last">Last name</Label>
                <Input id="ec-last" value={v.lastName} onChange={set("lastName")} placeholder="Last name" />
              </div>
            </div>

            {/* primary email */}
            <div className="grid gap-2">
              <Label htmlFor="ec-email">Primary email</Label>
              <Input id="ec-email" type="email" value={v.email} onChange={set("email")} placeholder="name@example.com" />
            </div>

            {/* secondary emails (chips) */}
            <div className="grid gap-2">
              <Label htmlFor="ec-email2">Secondary emails</Label>
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
                id="ec-email2"
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
                <Label htmlFor="ec-phone">Phone number</Label>
                <Input id="ec-phone" type="tel" value={v.phone} onChange={set("phone")} placeholder="07…" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ec-altphone">Alternate phone</Label>
                <Input id="ec-altphone" type="tel" value={v.altPhone} onChange={set("altPhone")} placeholder="Alternate phone" />
              </div>
            </div>

            {/* address */}
            <div className="border-t pt-4">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-mm-red">
                <MapPin className="size-4" strokeWidth={1.75} />
                Address
              </p>
              <AddressFields value={address} onChange={setAddress} idPrefix="ec-addr" />
            </div>

            {/* notes */}
            <div className="grid gap-2">
              <Label htmlFor="ec-notes">Notes</Label>
              <textarea
                id="ec-notes"
                value={v.notes}
                onChange={set("notes")}
                rows={3}
                placeholder="Any notes about this client…"
                className="focus-ring min-h-[72px] w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-mist-400"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy} className="h-11">
              Cancel
            </Button>
            <Button onClick={onSave} disabled={busy} className="h-11">
              {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive / restore — admin only. Restore is one tap; archiving confirms
          first (and the server action still blocks it while work is live). */}
      {isAdmin ? (
        archived ? (
          <Button
            variant="outline"
            onClick={toggleActive}
            disabled={archivePending}
            className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            {archivePending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <ArchiveRestore className="size-4 text-mist-400" strokeWidth={1.75} />
            )}
            Restore
          </Button>
        ) : (
          <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 hover:bg-muted hover:text-foreground"
              >
                <Archive className="size-4 text-mist-400" strokeWidth={1.75} />
                Archive
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="font-display">Archive this client?</DialogTitle>
                <DialogDescription>
                  They&apos;ll be hidden from the clients list but nothing is deleted — their
                  enquiries, quotes and paperwork stay intact, and you can restore them any time.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmArchive(false)} disabled={archivePending} className="h-11">
                  Cancel
                </Button>
                <Button onClick={toggleActive} disabled={archivePending} className="h-11">
                  {archivePending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
                  Archive client
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )
      ) : null}
    </>
  );
}
