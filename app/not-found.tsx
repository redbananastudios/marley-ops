import Link from "next/link";
import { BrandMark } from "@/components/app-sidebar";

/**
 * Branded 404. Without this file Next renders its own bare "This page could not
 * be found" — an unstyled white page with no way back, which is what a stale
 * bookmark to a retired route gave the office on 2026-08-23 after /growth,
 * /growth/ads and /schedule/board were removed.
 *
 * Lives at the ROOT (not inside (dashboard)) so it also covers a mistyped URL
 * outside the panel. One link is enough for every role: `/` sends office and
 * estimator to their dashboard and bounces crew straight to /my-jobs.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <BrandMark href="/" />

      <div className="max-w-md">
        <p className="text-sm font-semibold uppercase tracking-wide text-mist-400">Page not found</p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">
          That page isn&apos;t here any more
        </h1>
        <p className="mt-3 text-sm text-mist-500">
          The link you followed is out of date — some screens have moved or been retired. Job
          allocation now lives on <span className="font-medium text-foreground">Schedule &amp; Allocation</span>.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="focus-ring rounded-xl bg-mm-red px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        >
          Take me back
        </Link>
        <Link
          href="/manual"
          className="focus-ring rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-mist-500 hover:text-foreground"
        >
          User manual
        </Link>
      </div>
    </main>
  );
}
