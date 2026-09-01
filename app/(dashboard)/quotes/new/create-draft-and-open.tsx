"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createDraftQuote } from "@/app/(dashboard)/quotes/actions";

/**
 * QA-20260828-02: /quotes/new?leadId=… used to create the draft quote DURING
 * the page's server render and then redirect(). Next can invoke that render
 * twice for one client-side navigation — the DB race was already handled
 * (quotes_one_draft_per_lead_uq + re-read-the-winner), but nothing handled the
 * two redirect() throws, so the soft navigation intermittently crashed to the
 * generic error boundary even though the draft committed underneath (first
 * seen at the survey-dialog entry point, QA-20260827-03). That fix made ONE
 * deterministic server-action call from the click handler; this component does
 * the same for the seven <Link> entry points at once, by keeping the page
 * render read-only and creating the draft here, after mount, exactly once.
 */
export function CreateDraftAndOpen({ leadId }: { leadId: string }) {
  const router = useRouter();
  const fired = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Dev strict mode remounts run effects twice; one action call is the
    // whole point, so guard it. (A duplicate would still be absorbed by the
    // unique-index winner re-read, but there is no reason to lean on it.)
    if (fired.current) return;
    fired.current = true;
    createDraftQuote({ leadId })
      .then((res) => {
        if (res.ok) router.replace(`/quotes/${res.id}`);
        else setError(res.error || "Could not create a new quote.");
      })
      .catch(() => setError("Could not create a new quote."));
  }, [leadId, router]);

  if (error) {
    return (
      <div className="flex max-w-2xl flex-col items-start gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <Link href="/quotes" className="text-sm underline underline-offset-2">
          Back to quotes
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-mist-500">
      <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
      Creating quote…
    </div>
  );
}
