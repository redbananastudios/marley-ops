import { Clock, PhoneCall } from "lucide-react";
import { chaseStatusLine, type ChaseStatusLineArgs } from "@/lib/quote/chase-status";
import { cn } from "@/lib/utils";

/**
 * One quiet line telling the office where the chase engine is on this lead —
 * "Chase 1 of 3 sent 12 Jul · next around 15 Jul". Renders nothing when there's
 * nothing to chase (draft/confirmed/completed/declined, or an old quote). Pure
 * server component; the logic lives in the tested `chaseStatusLine` helper.
 */
export function ChaseStatusLine({
  className,
  ...args
}: ChaseStatusLineArgs & { className?: string }) {
  const status = chaseStatusLine(args);
  if (!status) return null;
  const Icon = status.tone === "warn" ? PhoneCall : Clock;
  return (
    <p
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        status.tone === "warn" ? "text-warn" : "text-mist-400",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      {status.text}
    </p>
  );
}
