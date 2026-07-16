"use client";

/**
 * Route-level error boundary — an unexpected render/data failure shows a
 * branded recover screen instead of Next's white "Application error" page
 * (review 2026-07-16: the app had NO error boundaries, so any uncaught
 * server-component throw was a dead end on an iPad mid-job).
 */

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logs carry the real stack; the digest ties this render to it.
    console.error("route-error", error.digest ?? "", error.message);
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-warn-bg">
          <TriangleAlert className="size-6 text-warn" strokeWidth={1.75} />
        </div>
        <h1 className="font-display text-xl font-semibold text-foreground">
          Something went wrong loading this page
        </h1>
        <p className="mt-2 text-sm text-mist-500">
          Your data is safe — this is a display problem, not a lost record. Try again; if it keeps
          happening, tell Peter and quote{" "}
          <span className="tabular font-medium text-foreground">{error.digest ?? "no-digest"}</span>.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md bg-mm-red px-4 text-sm font-semibold text-white transition-colors hover:brightness-95"
          >
            <RotateCcw className="size-4" strokeWidth={2} />
            Try again
          </button>
          <Link
            href="/"
            className="focus-ring inline-flex min-h-11 items-center rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
          >
            Go to the dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
