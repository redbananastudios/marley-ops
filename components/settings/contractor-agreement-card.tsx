"use client";

/**
 * Settings › Contractor agreement (shown to estimators — they're self-employed
 * contractors too). One-time signature, filed in the Documents register. Crew
 * sign the same agreement from their own /my-jobs portal.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileSignature } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { ContractorAgreementSign } from "@/components/contractor/agreement-sign";

export function ContractorAgreementCard({ signedAt }: { signedAt: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (signedAt) {
    return (
      <Card className="p-0">
        <div className="flex items-center gap-3 border-b px-5 py-3.5">
          <FileSignature className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Contractor agreement</h2>
            <p className="mt-0.5 text-xs text-mist-400">Your self-employed contractor agreement with Marley Moves.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-5 text-sm text-success">
          <CheckCircle2 className="size-5 shrink-0" strokeWidth={1.75} />
          <span>
            Signed {new Date(signedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <FileSignature className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Contractor agreement</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            A one-time signature confirming you work with Marley Moves as a self-employed contractor.
          </p>
        </div>
      </div>
      <div className="p-5">
        {open ? (
          <ContractorAgreementSign
            onSigned={() => {
              toast.success("Thanks — your contractor agreement is signed.");
              setOpen(false);
              router.refresh();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="focus-ring inline-flex min-h-11 items-center rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep"
          >
            Read and sign
          </button>
        )}
      </div>
    </Card>
  );
}
