"use client";

/**
 * Settings › Quick sign-in. Lets any signed-in user add a passkey to the device
 * they're on and manage the devices they've registered. Wraps the shared
 * QuickSigninSetup in the Settings card shell.
 */

import { Fingerprint } from "lucide-react";
import { Card } from "@/components/ui/card";
import { QuickSigninSetup } from "@/components/auth/quick-signin-setup";

export function QuickSigninCard() {
  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Fingerprint className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Quick sign-in</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Sign in with Face ID, fingerprint or your device PIN instead of a password.
          </p>
        </div>
      </div>
      <div className="p-5">
        <QuickSigninSetup />
      </div>
    </Card>
  );
}
