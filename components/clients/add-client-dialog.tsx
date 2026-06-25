"use client";

/**
 * Add a client directly (manual entry). Dedupes on phone/email as you go — if the
 * person already exists it attaches rather than duplicating. New clients show a
 * "Manual" origin until a lead gives them a real acquisition source.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, TriangleAlert } from "lucide-react";
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
import { createClientAction, checkClientDuplicateAction } from "@/app/(dashboard)/clients/actions";

interface Values {
  name: string;
  phone: string;
  email: string;
  postcode: string;
}

const EMPTY: Values = { name: "", phone: "", email: "", postcode: "" };

export function AddClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Values>(EMPTY);
  const [dupe, setDupe] = useState<{ clientName: string | null; previousLeadCount: number } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

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
    if (!v.name.trim()) {
      toast.error("Add a name.");
      return;
    }
    setBusy(true);
    try {
      const res = await createClientAction({
        name: v.name,
        phone: v.phone || undefined,
        email: v.email || undefined,
        postcode: v.postcode || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.matched ? "Matched an existing client." : "Client added.");
      setOpen(false);
      setV(EMPTY);
      setDupe(null);
      router.push(`/clients/${res.clientId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-9">
          <Plus strokeWidth={1.75} />
          Add client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Add client</DialogTitle>
          <DialogDescription>A person or household. We check for an existing match on phone or email.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="ac-name">Name</Label>
            <Input id="ac-name" value={v.name} onChange={set("name")} placeholder="Customer name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ac-phone">Phone</Label>
              <Input id="ac-phone" type="tel" value={v.phone} onChange={set("phone")} onBlur={onDedupeBlur} placeholder="07…" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ac-email">Email</Label>
              <Input id="ac-email" type="email" value={v.email} onChange={set("email")} onBlur={onDedupeBlur} placeholder="name@example.com" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ac-postcode">Postcode</Label>
            <Input id="ac-postcode" value={v.postcode} onChange={set("postcode")} placeholder="SP7 9PX" />
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
      </DialogContent>
    </Dialog>
  );
}
