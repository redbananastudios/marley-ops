/**
 * The dashboard's Suspense fallback — and, more importantly, the thing that
 * lets the post-login navigation commit.
 *
 * `app/(auth)/login/page.tsx` pushes "/" for every role, so this page is the
 * login critical path. Before this existed there was no `<Suspense>` boundary
 * anywhere in `app/`, which meant the client router could not commit the URL
 * until the whole dashboard RSC payload had arrived AND rendered. Measured on
 * CI run 33121391706: 17.8s (office), 16.3s (estimator), 10.2s (crew) from the
 * "Sign in" click to the URL leaving /login — every e2e auth-setup step timed
 * out and none of the 175 downstream tests ran.
 *
 * So this is deliberately static: no data, no imports that read anything, no
 * client JS. Anything it awaited would go straight back into the critical path
 * it exists to clear.
 *
 * Shape mirrors `dashboard-view.tsx`'s own `<main className="page-shell …">`
 * and its tile grid, so the swap is a fill rather than a re-layout.
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-mist-100 ${className}`} />;
}

function TileSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-5">
      <Block className="mb-4 h-3 w-24" />
      <Block className="mb-2 h-8 w-20" />
      <Block className="h-3 w-32" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <main className="page-shell flex-1 space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div>
        <Block className="mb-2 h-8 w-56" />
        <Block className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <TileSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border bg-card p-5">
            <Block className="mb-4 h-3 w-32" />
            <div className="space-y-3">
              {[0, 1, 2, 3].map((r) => (
                <Block key={r} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
