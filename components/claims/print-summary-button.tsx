"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The insurer pack v1: the claim page carries everything (description, trail,
 *  evidence links) — printing it (or "Save as PDF") is the exportable summary.
 *  The page's print stylesheet hides the app chrome. */
export function PrintSummaryButton() {
  return (
    <Button variant="outline" size="sm" className="h-9 print:hidden" onClick={() => window.print()}>
      <Printer className="size-4" strokeWidth={1.75} />
      Print summary
    </Button>
  );
}
