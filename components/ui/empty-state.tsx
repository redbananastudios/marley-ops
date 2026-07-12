import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared empty state — icon, one bold line, one hint line, optional action.
 * Same shape as the estimator My-day "no surveys" card so every surface's
 * "nothing here" reads identically (part of the shared status/action
 * vocabulary; plain grey sentences read as unfinished).
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-6 py-12 text-center", className)}>
      <Icon className="mx-auto size-7 text-mist-300" strokeWidth={1.5} />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-xs text-mist-400">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
