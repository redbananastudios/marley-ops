"use client";

/** Resend the stored completion certificate — the office recovery path when
 *  the original email failed or the customer lost it. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { resendCertificateAction } from "@/app/actions/crew-signatures";

export function ResendCertificateButton({ completionId }: { completionId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  function send() {
    start(async () => {
      const res = await resendCertificateAction(completionId);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Certificate emailed to the customer.");
        router.refresh();
      }
      setConfirming(false);
    });
  }

  return confirming ? (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={send}
        disabled={pending}
        className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-medium text-white hover:bg-mm-red-deep disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Send className="size-4" strokeWidth={1.75} />}
        Confirm resend
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="focus-ring text-sm text-mist-400 hover:text-foreground"
      >
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
    >
      <Send className="size-4" strokeWidth={1.75} />
      Resend certificate
    </button>
  );
}
