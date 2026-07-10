"use client";

/**
 * Doorstep contract collection — the crew-tablet fallback when the contract
 * was never signed remotely (Peter, 2026-07-10). Same acknowledgment set as
 * /q, plus a finger-drawn signature; the record is identical except
 * channel='in_person'. Lives on the /my-jobs/[id] amber banner.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PenLine } from "lucide-react";
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
import { SignaturePad } from "@/components/signature-pad";
import { CONTRACT_ACKS, TERMS_URL, type ContractAckKey } from "@/lib/signatures";
import { signContractInPersonAction } from "@/app/actions/crew-signatures";

const NO_ACKS: Record<ContractAckKey, boolean> = { inventory: false, owner_packed: false, no_hazardous: false };

export function CollectContractButton({
  appointmentId,
  customerName,
}: {
  appointmentId: string;
  customerName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(customerName);
  const [acks, setAcks] = useState(NO_ACKS);
  const [sig, setSig] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ready = CONTRACT_ACKS.every((a) => acks[a.key]) && !!sig && name.trim().length >= 2;

  function submit() {
    start(async () => {
      const res = await signContractInPersonAction(appointmentId, {
        signerName: name.trim(),
        signatureDataUri: sig!,
        acks,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Contract signed — you're good to go.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setName(customerName);
          setAcks(NO_ACKS);
          setSig(null);
          setOpen(true);
        }}
        className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-4 text-sm font-semibold text-white transition-colors hover:bg-mm-red-deep"
      >
        <PenLine className="size-4" strokeWidth={1.75} />
        Collect signature now
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Contract signature</DialogTitle>
            <DialogDescription>
              Hand the customer this device. They tick each confirmation and sign with a finger —
              it&apos;s the same acceptance they&apos;d have done online, covering our{" "}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                terms &amp; conditions
              </a>
              .
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-2">
              {CONTRACT_ACKS.map((a) => (
                <label
                  key={a.key}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red-tint/30"
                >
                  <input
                    type="checkbox"
                    checked={acks[a.key]}
                    onChange={(e) => setAcks((s) => ({ ...s, [a.key]: e.target.checked }))}
                    className="size-5 shrink-0 accent-mm-red"
                  />
                  <span className="text-sm leading-snug text-foreground">{a.label}</span>
                </label>
              ))}
            </div>

            <div>
              <label htmlFor="contract-name" className="eyebrow mb-1.5 block">
                Customer&apos;s full name
              </label>
              <input
                id="contract-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="focus-ring h-12 w-full rounded-md border border-input bg-card px-3 text-base"
              />
            </div>

            <div>
              <p className="eyebrow mb-1.5">Customer&apos;s signature</p>
              <SignaturePad onChange={setSig} label="Customer signs here" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !ready} className="bg-mm-red text-white hover:bg-mm-red-deep">
              {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
              Save signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
