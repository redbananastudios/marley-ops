import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES = {
  red: "border-red-100 bg-red-50 text-mm-red",
  blue: "border-blue-100 bg-blue-50 text-info",
  teal: "border-teal-100 bg-teal-50 text-survey",
  green: "border-green-100 bg-green-50 text-success",
  amber: "border-amber-100 bg-amber-50 text-amber-600",
  violet: "border-violet-100 bg-violet-50 text-violet",
  neutral: "border-border bg-muted text-mist-500",
} as const;

export function IconBadge({
  icon: Icon,
  tone = "neutral",
  className,
  iconClassName,
}: {
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-grid size-10 shrink-0 place-items-center rounded-lg border",
        TONES[tone],
        className,
      )}
    >
      <Icon className={cn("size-5", iconClassName)} strokeWidth={1.65} />
      <span className="pointer-events-none absolute inset-px rounded-[7px] border border-white/55" />
    </span>
  );
}
