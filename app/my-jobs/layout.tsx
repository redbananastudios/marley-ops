import type { ReactNode } from "react";
import { PushSwRegister } from "@/components/push/sw-register";
import { OutboxProvider } from "@/components/offline/outbox-provider";
import { OfflineSyncBar } from "@/components/offline/offline-sync-bar";

/**
 * Crew shell. Registers the service worker (push + the A2 read-cache), wraps the
 * crew surfaces in the offline outbox (A3) so a completion taken with no signal
 * is queued + synced, and mounts the persistent connection/sync status bar
 * across every /my-jobs surface.
 */
export default function MyJobsLayout({ children }: { children: ReactNode }) {
  return (
    <OutboxProvider>
      <PushSwRegister />
      {children}
      <OfflineSyncBar />
    </OutboxProvider>
  );
}
