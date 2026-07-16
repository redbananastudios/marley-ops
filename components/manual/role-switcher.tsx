import Link from "next/link";
import { cn } from "@/lib/utils";

export type ManualView = "office" | "estimator" | "crew";

const VIEWS: { view: ManualView; label: string }[] = [
  { view: "office", label: "Office" },
  { view: "estimator", label: "Estimator" },
  { view: "crew", label: "Crew" },
];

/**
 * Admin-only preview switcher on /manual — plain links (server-rendered, no
 * client JS) so Peter/Connor can read each role's manual exactly as that role
 * sees it. Estimators and crew never see this; they only get their own manual.
 */
export function ManualRoleSwitcher({ active }: { active: ManualView }) {
  return (
    <nav aria-label="Preview a role's manual" className="mb-7 print:hidden">
      <div className="inline-flex rounded-lg border border-border bg-card p-1">
        {VIEWS.map(({ view, label }) => (
          <Link
            key={view}
            href={view === "office" ? "/manual" : `/manual?view=${view}`}
            aria-current={active === view ? "page" : undefined}
            className={cn(
              "focus-ring rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors",
              active === view ? "bg-mm-red text-white" : "text-mist-500 hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-mist-400">
        You&apos;re an admin, so you can preview every role&apos;s manual. Estimators and crew each see only their
        own.
      </p>
    </nav>
  );
}
