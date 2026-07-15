"use client";

/**
 * Settings › Notifications — the whole Web Push journey on one card:
 * capability detection, the contextual pre-prompt (never auto-prompted — PRD
 * §16.1), enable/disable for THIS device, category preferences, the admin
 * kill switches and the admin self-test send.
 *
 * State model lives in lib/push/client.ts (pure, tested); this component is
 * the browser IO around it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getPushConfigAction,
  reconcileSubscriptionAction,
  removeSubscriptionAction,
  saveSubscriptionAction,
  sendTestPushAction,
  setPushFlagsAction,
  setPushPreferencesAction,
  type PushConfig,
} from "@/app/actions/push";
import {
  derivePushUiState,
  detectInstallRequired,
  getOrCreateInstallationId,
  urlBase64ToUint8Array,
  type PushUiState,
} from "@/lib/push/client";

type NavigatorStandalone = Navigator & { standalone?: boolean };

function supportedHere(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function installRequiredHere(): boolean {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as NavigatorStandalone).standalone === true;
  return detectInstallRequired({
    userAgent: navigator.userAgent,
    standalone,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

async function subscriptionJson(sub: PushSubscription, installationId: string) {
  const raw = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: raw.keys?.p256dh ?? "", auth: raw.keys?.auth ?? "" },
    installationId,
  };
}

export function NotificationsSetup({ isAdmin }: { isAdmin: boolean }) {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unknown">("unknown");
  const [hasSubscription, setHasSubscription] = useState(false);
  const [serverRegistered, setServerRegistered] = useState(false);
  const [installRequired, setInstallRequired] = useState(false);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Fetch config first — every setState below then runs after an await,
    // never synchronously inside the mounting effect.
    const cfg = await getPushConfigAction();
    const ok = supportedHere();
    setSupported(ok);
    // Independent of `supported`: an iOS Safari TAB hides the push APIs
    // entirely, and the correct state there is install_required.
    setInstallRequired(installRequiredHere());
    if (ok) setPermission(Notification.permission);
    setConfig(cfg);

    if (ok && Notification.permission === "granted") {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        setHasSubscription(!!sub);
        if (sub && cfg?.enabled) {
          // Startup reconciliation (PRD §16.3) — read-only against the server:
          // "mine" refreshes the enabled state; anything else (missing row,
          // revoked, or owned by another user of this shared device) shows
          // Repair/Enable so changing ownership stays an explicit gesture.
          const res = await reconcileSubscriptionAction({ endpoint: sub.endpoint });
          setServerRegistered(res.ok && res.state === "mine");
        }
      } catch {
        setHasSubscription(false);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state: PushUiState = useMemo(
    () =>
      derivePushUiState({
        supported,
        installRequired,
        systemEnabled: config?.enabled ?? false,
        permission,
        hasSubscription,
        serverRegistered,
      }),
    [supported, installRequired, config, permission, hasSubscription, serverRegistered],
  );

  async function enable() {
    if (!config?.vapidPublicKey) {
      toast.error("Push is not configured on the server yet.");
      return;
    }
    setBusy(true);
    try {
      // Permission FIRST, straight off the click: WebKit ties the prompt to
      // transient user activation, and awaiting SW registration first can
      // burn it on a first-ever visit (prompt then silently fails).
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        if (perm === "denied") toast.error("Notifications are blocked for this site in your browser settings.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const appKey = urlBase64ToUint8Array(config.vapidPublicKey);

      // A subscription minted under an OLD VAPID key is undeliverable after a
      // key rotation — detect the mismatch and re-subscribe fresh.
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        const current = sub.options.applicationServerKey
          ? new Uint8Array(sub.options.applicationServerKey as ArrayBuffer)
          : null;
        const matches =
          !!current && current.length === appKey.length && current.every((b, i) => b === appKey[i]);
        if (!matches) {
          await sub.unsubscribe().catch(() => {});
          sub = null;
        }
      }
      sub =
        sub ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appKey as unknown as BufferSource,
        }));
      const id = getOrCreateInstallationId(window.localStorage);
      const res = await saveSubscriptionAction(await subscriptionJson(sub, id));
      if (!res.ok) {
        toast.error(res.error);
        setHasSubscription(true);
        setServerRegistered(false);
        return;
      }
      setHasSubscription(true);
      setServerRegistered(true);
      toast.success("Notifications enabled on this device.");
    } catch {
      toast.error("Could not enable notifications — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Server first — if the revoke fails, stop and say so rather than
        // unsubscribing the browser and toasting a false "disabled".
        const res = await removeSubscriptionAction({ endpoint: sub.endpoint });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const browserOk = await sub.unsubscribe().catch(() => false);
        if (!browserOk) {
          toast.warning("Turned off — the browser subscription may need clearing in site settings.");
          setHasSubscription(true);
          setServerRegistered(false);
          return;
        }
      }
      setHasSubscription(false);
      setServerRegistered(false);
      toast.success("Notifications disabled on this device.");
    } catch {
      toast.error("Could not disable — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleCategory(id: string, enabled: boolean) {
    setConfig((c) =>
      c ? { ...c, categories: c.categories.map((cat) => (cat.id === id ? { ...cat, enabled } : cat)) } : c,
    );
    const res = await setPushPreferencesAction({ [id]: enabled });
    if (!res.ok) {
      toast.error(res.error);
      void refresh();
    }
  }

  async function toggleFlag(key: "enabled" | "new_enquiry" | "payment_event" | "crew_job", value: boolean) {
    const res = await setPushFlagsAction({ [key]: value });
    if (!res.ok) toast.error(res.error);
    void refresh();
  }

  async function sendTest() {
    setBusy(true);
    const res = await sendTestPushAction();
    setBusy(false);
    if (!res.ok) toast.error(res.error);
    else toast.success(`Test sent to ${res.accepted} of ${res.attempted} device${res.attempted === 1 ? "" : "s"}.`);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-mist-400">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> Checking this device…
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {/* ------------------------------------------------ this-device state */}
      {state === "unsupported" ? (
        <p className="text-sm text-mist-400">
          This browser doesn&apos;t support push notifications. Everything else works as normal — alerts
          still appear inside the app.
        </p>
      ) : state === "install_required" ? (
        <div className="rounded-lg border bg-muted/40 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Smartphone className="size-4 text-mm-red" strokeWidth={1.75} /> Add Marley Ops to your Home Screen first
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-mist-400">
            <li>Tap the Share button in Safari</li>
            <li>Choose &ldquo;Add to Home Screen&rdquo;</li>
            <li>Open Marley Ops from the new icon, then enable notifications here</li>
          </ol>
          <p className="mt-2 text-xs text-mist-400">
            iPhone and iPad only deliver notifications to installed web apps.
          </p>
        </div>
      ) : state === "admin_disabled" ? (
        <p className="text-sm text-mist-400">
          Notifications are currently switched off for the whole business
          {isAdmin ? " — use the switches below to turn them on." : ". An admin can enable them in Settings."}
        </p>
      ) : state === "blocked" ? (
        <p className="text-sm text-mist-400">
          Notifications are blocked for this site. To use them, allow notifications for
          ops.marleymoves.co.uk in your browser or device settings, then come back here.
        </p>
      ) : state === "enabled" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-pill bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">
            Enabled on this device
          </span>
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={disable} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Turn off on this device
          </Button>
          {isAdmin ? (
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={sendTest} disabled={busy}>
              Send test notification
            </Button>
          ) : null}
        </div>
      ) : state === "needs_repair" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-mist-400">
            This device&apos;s registration needs repairing before notifications arrive.
          </p>
          <Button type="button" size="sm" className="h-9" onClick={enable} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Repair
          </Button>
        </div>
      ) : (
        <div>
          <p className="text-sm text-mist-400">
            Get operational updates on this device even when Marley Ops is closed — you choose which
            alerts you receive and can turn them off at any time.
          </p>
          <Button type="button" size="sm" className="mt-3 h-9" onClick={enable} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <BellRing className="size-4" strokeWidth={1.75} />}
            Enable notifications
          </Button>
        </div>
      )}

      {/* --------------------------------------------- category preferences */}
      {config && state === "enabled" ? (
        <div className="grid gap-2 border-t pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">What you receive</p>
          {config.categories.map((cat) => (
            <label key={cat.id} className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={cat.enabled}
                onChange={(e) => toggleCategory(cat.id, e.target.checked)}
                className="mt-0.5 size-5 accent-mm-red"
              />
              <span>
                <span className="font-semibold text-foreground">{cat.label}</span>
                <span className="block text-xs text-mist-400">{cat.description}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------ admin kill switch */}
      {isAdmin && config ? (
        <div className="grid gap-2 border-t pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">
            Business-wide switches (admin)
          </p>
          <label className="flex items-center gap-2.5 text-sm font-semibold">
            <input
              type="checkbox"
              checked={config.flags?.enabled ?? false}
              onChange={(e) => toggleFlag("enabled", e.target.checked)}
              disabled={!config.configured}
              className="size-5 accent-mm-red"
            />
            Push notifications system
          </label>
          {!config.configured ? (
            <p className="text-xs text-mist-400">Server keys are not configured — contact support.</p>
          ) : null}
          <label className="ml-6 flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={config.flags?.categories.new_enquiry ?? true}
              onChange={(e) => toggleFlag("new_enquiry", e.target.checked)}
              disabled={!config.flags?.enabled}
              className="size-5 accent-mm-red"
            />
            New enquiries
          </label>
          <label className="ml-6 flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={config.flags?.categories.payment_event ?? true}
              onChange={(e) => toggleFlag("payment_event", e.target.checked)}
              disabled={!config.flags?.enabled}
              className="size-5 accent-mm-red"
            />
            Payments
          </label>
          <label className="ml-6 flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={config.flags?.categories.crew_job ?? true}
              onChange={(e) => toggleFlag("crew_job", e.target.checked)}
              disabled={!config.flags?.enabled}
              className="size-5 accent-mm-red"
            />
            Crew job assignments
          </label>
          <p className="text-xs text-mist-400">
            Turning a switch off stops those notifications for everyone, instantly, without a deploy.
          </p>
        </div>
      ) : null}
    </div>
  );
}
