"use client";

import { useState } from "react";
import { Check, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getCubicShareLinkAction } from "@/app/actions/cubic-survey";

/** Mints (lazily) + copies the customer self-fill link — /q "copy link" model. */
export function CopyCubicLinkButton({ surveyId }: { surveyId: string }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await getCubicShareLinkAction(surveyId);
        setBusy(false);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        try {
          await navigator.clipboard.writeText(res.url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
          toast.success("Customer link copied — they can fill the list themselves.");
        } catch {
          window.prompt("Copy the customer link:", res.url);
        }
      }}
      className="focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
      ) : copied ? (
        <Check className="size-4 text-success" strokeWidth={2} />
      ) : (
        <Link2 className="size-4" strokeWidth={1.75} />
      )}
      {copied ? "Copied" : "Copy customer link"}
    </button>
  );
}
