"use client";

/**
 * Quick sign-in (passkey) device manager — register THIS device, see your
 * registered devices, remove any. Works for every role: office reach it from
 * Settings, crew from a quiet disclosure on /my-jobs. Self-fetches the device
 * list so the parent server component stays decoupled. "Add this device" only
 * shows when the browser has a platform authenticator (Face ID / fingerprint /
 * device PIN); the list always shows so a synced passkey is visible everywhere.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Fingerprint, Loader2, Trash2 } from "lucide-react";
import { platformAuthenticatorIsAvailable, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { toast } from "sonner";
import {
  deletePasskeyAction,
  listPasskeysAction,
  startPasskeyRegistrationAction,
  verifyPasskeyRegistrationAction,
  type PasskeySummary,
} from "@/app/actions/passkeys";
import { deviceLabelFromUserAgent } from "@/lib/auth/passkey-helpers";
import { Button } from "@/components/ui/button";

function isCancel(err: unknown): boolean {
  if (err instanceof WebAuthnError && err.code === "ERROR_CEREMONY_ABORTED") return true;
  return err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
}

function fmt(date: string): string {
  return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function QuickSigninSetup() {
  const [available, setAvailable] = useState(false);
  const [devices, setDevices] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDevices(await listPasskeysAction());
  }, []);

  useEffect(() => {
    platformAuthenticatorIsAvailable()
      .then(setAvailable)
      .catch(() => {});
    void refresh();
  }, [refresh]);

  async function addDevice() {
    setBusy(true);
    try {
      const start = await startPasskeyRegistrationAction();
      if (!start.ok) {
        toast.error(start.error);
        return;
      }
      const attestation = await startRegistration({ optionsJSON: start.options });
      const res = await verifyPasskeyRegistrationAction(attestation, deviceLabelFromUserAgent(navigator.userAgent));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      try {
        localStorage.setItem("mm-passkey-hint", "1");
      } catch {}
      toast.success("Quick sign-in added on this device.");
      await refresh();
    } catch (err) {
      if (isCancel(err)) return;
      if (err instanceof WebAuthnError && err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
        toast.message("This device is already set up for quick sign-in.");
        return;
      }
      toast.error("Could not set up quick sign-in on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setRemovingId(id);
    try {
      const res = await deletePasskeyAction(id);
      if (!res.ok) {
        toast.error("Could not remove that device.");
        return;
      }
      toast.success("Device removed.");
      await refresh();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {available ? (
        <Button type="button" onClick={addDevice} disabled={busy} className="min-h-11">
          {busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
          ) : (
            <Fingerprint className="size-4" strokeWidth={1.75} />
          )}
          Add this device
        </Button>
      ) : (
        <p className="text-sm text-mist-400">
          This device doesn&apos;t offer Face ID, fingerprint or a device PIN, so quick sign-in can&apos;t be added here.
        </p>
      )}

      {devices === null ? (
        <p className="text-sm text-mist-400">Loading your devices…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-mist-400">No devices set up yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />
                  {d.deviceLabel ?? "Registered device"}
                </p>
                <p className="mt-0.5 text-xs text-mist-400">
                  Added {fmt(d.createdAt)}
                  {d.lastUsedAt ? ` · last used ${fmt(d.lastUsedAt)}` : " · not used yet"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(d.id)}
                disabled={removingId === d.id}
                className="shrink-0 text-mist-500 hover:text-danger"
                aria-label={`Remove ${d.deviceLabel ?? "device"}`}
              >
                {removingId === d.id ? (
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Trash2 className="size-4" strokeWidth={1.75} />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
