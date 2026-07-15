"use client";

/**
 * Crew entry point for passkey quick sign-in. Crew never see Settings, and their
 * phones benefit most from Face ID / fingerprint sign-in — so this gives them a
 * single quiet disclosure below their job list. Collapsed by default; expands to
 * the shared device manager.
 */

import { ChevronDown, Fingerprint } from "lucide-react";
import { QuickSigninSetup } from "@/components/auth/quick-signin-setup";

export function QuickSigninRow() {
  return (
    <details className="group mt-8 rounded-xl border border-border bg-card">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-mist-500 hover:text-foreground">
        <Fingerprint className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        Set up quick sign-in
        <ChevronDown
          className="ml-auto size-4 text-mist-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>
      <div className="border-t border-border px-4 py-4">
        <p className="mb-3 text-sm text-mist-500">
          Sign in with Face ID, fingerprint or your phone&apos;s PIN instead of a password.
        </p>
        <QuickSigninSetup />
      </div>
    </details>
  );
}
