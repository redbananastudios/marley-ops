import type { ReactNode } from "react";
import { PushSwRegister } from "@/components/push/sw-register";
import { OfflineBanner } from "@/components/pwa/offline-banner";

/**
 * Crew shell. Registers the service worker (push + the A2 read-cache) and mounts
 * the persistent offline indicator across every /my-jobs surface — so caching
 * and the offline banner aren't limited to the jobs list, and a crew member deep
 * in a job (or on /pay, /availability) still gets both.
 */
export default function MyJobsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PushSwRegister />
      {children}
      <OfflineBanner />
    </>
  );
}
