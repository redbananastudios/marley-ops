"use client";

/**
 * Passkey (Face ID / fingerprint / device PIN) sign-in button for the login
 * screen. Renders only when the browser exposes a platform authenticator —
 * always shown when it does (not hint-gated) so an iCloud/Google-synced passkey
 * works the first time on a fresh device. On success we swap the server's
 * magiclink hashed_token for a real session with the browser Supabase client,
 * then land on the dashboard.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Loader2 } from "lucide-react";
import {
  platformAuthenticatorIsAvailable,
  startAuthentication,
  WebAuthnError,
} from "@simplewebauthn/browser";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { startPasskeyAuthAction, verifyPasskeyAuthAction } from "@/app/actions/passkeys";
import { Button } from "@/components/ui/button";

/** Establish the session from a magiclink hashed token. GoTrue self-hosted has
 *  historically accepted a magiclink token_hash under either 'magiclink' or
 *  'email' — try the matching type, fall back to 'email' if the version differs. */
async function establishSession(tokenHash: string): Promise<boolean> {
  const supabase = createClient();
  const first = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (!first.error) return true;
  const second = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  return !second.error;
}

export function PasskeySignInButton() {
  const router = useRouter();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    platformAuthenticatorIsAvailable()
      .then((ok) => {
        if (active) setAvailable(ok);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function onClick() {
    setBusy(true);
    try {
      const start = await startPasskeyAuthAction();
      if (!start.ok) {
        toast.error(start.error);
        return;
      }
      const assertion = await startAuthentication({ optionsJSON: start.options });
      const verified = await verifyPasskeyAuthAction(assertion);
      if (!verified.ok) {
        toast.error(verified.error);
        return;
      }
      const ok = await establishSession(verified.tokenHash);
      if (!ok) {
        toast.error("Could not complete sign-in — use your password.");
        return;
      }
      // Remember this device liked a passkey (future UI can lead with it).
      try {
        localStorage.setItem("mm-passkey-hint", "1");
      } catch {}
      router.replace("/");
      router.refresh();
    } catch (err) {
      // User dismissed the platform sheet, or has no passkey on this device.
      if (err instanceof WebAuthnError && err.code === "ERROR_CEREMONY_ABORTED") return;
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) return;
      toast.message("No passkey on this device yet", {
        description: "Sign in with your password, then add quick sign-in from Settings.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;

  return (
    <div className="mt-4">
      <div className="relative mb-4 flex items-center">
        <span className="flex-1 border-t border-border" />
        <span className="px-3 text-xs text-mist-400">or</span>
        <span className="flex-1 border-t border-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onClick}
        disabled={busy}
        className="min-h-11 w-full"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
        ) : (
          <Fingerprint className="size-4" strokeWidth={1.75} />
        )}
        Sign in with Face ID or fingerprint
      </Button>
    </div>
  );
}
