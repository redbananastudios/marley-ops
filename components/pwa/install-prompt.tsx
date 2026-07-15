"use client";

/**
 * "Install the app" row (Peter, 2026-07-15 — crew should run the installed
 * PWA, not a browser tab). Renders nothing once the app IS installed.
 *
 * Android/Chromium: captures the browser's beforeinstallprompt event and
 * offers a one-tap Install button (the real native prompt).
 * iOS/iPadOS: no install API exists — shows the Add-to-Home-Screen steps.
 * Mirrors the quick-signin-row disclosure pattern.
 */

import { useEffect, useState } from "react";
import { ChevronDown, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isAppleMobile(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [apple, setApple] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) return;
    setApple(isAppleMobile());
    setVisible(true);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setVisible(false);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!visible) return null;

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") {
      toast.success("Installing — open Marley Ops from your Home Screen.");
      setVisible(false);
    }
    setInstallEvent(null);
  }

  return (
    <details className="group mt-3 rounded-xl border border-border bg-card" open={!apple && !!installEvent}>
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-mist-500 hover:text-foreground">
        <MonitorSmartphone className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        Install the Marley Ops app
        <ChevronDown
          className="ml-auto size-4 text-mist-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
        />
      </summary>
      <div className="border-t border-border px-4 py-4">
        {apple ? (
          <>
            <p className="mb-2 text-sm text-mist-500">
              Add Marley Ops to your Home Screen for the full app — it opens full-screen and can
              receive notifications:
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-mist-500">
              <li>Tap the Share button in Safari</li>
              <li>Choose &ldquo;Add to Home Screen&rdquo;</li>
              <li>Open Marley Ops from the new icon</li>
            </ol>
          </>
        ) : installEvent ? (
          <>
            <p className="mb-3 text-sm text-mist-500">
              One tap installs Marley Ops on this device — full-screen, on your home screen, with
              notifications.
            </p>
            <button
              type="button"
              onClick={install}
              className="focus-ring h-10 rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep"
            >
              Install app
            </button>
          </>
        ) : (
          <p className="text-sm text-mist-500">
            In your browser&apos;s menu, choose &ldquo;Add to Home Screen&rdquo; (or
            &ldquo;Install app&rdquo;) to put Marley Ops on this device.
          </p>
        )}
      </div>
    </details>
  );
}
