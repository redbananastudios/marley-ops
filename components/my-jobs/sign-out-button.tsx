"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    // Wipe the crew read-cache so the next person on a shared phone can't reopen
    // this crew member's cached jobs (they carry customer PII). Best-effort:
    // message the SW, and delete directly as a belt-and-braces fallback.
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: "mm-clear-cache" });
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("mo-")).map((n) => caches.delete(n)));
      }
    } catch {
      // never block sign-out on a cache-clear hiccup
    }
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      type="button"
      onClick={signOut}
      className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-mist-500 hover:bg-muted hover:text-foreground"
    >
      <LogOut className="size-4" strokeWidth={1.75} />
      Sign out
    </button>
  );
}
