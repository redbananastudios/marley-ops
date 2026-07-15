"use client";

import Link from "next/link";
import { CalendarPlus, FilePlus2, Plus, UserPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconBadge } from "@/components/ui/icon-badge";
import { cn } from "@/lib/utils";

const STARTS = [
  {
    href: "/leads/new",
    label: "Add lead",
    description: "Add a new enquiry or phone caller",
    icon: UserPlus,
    tone: "red" as const,
  },
  {
    href: "/schedule/surveys?new=1",
    label: "Book survey",
    description: "Choose a customer, estimator and time",
    icon: CalendarPlus,
    tone: "teal" as const,
  },
  {
    href: "/quotes/new",
    label: "New quote",
    description: "Capture the move and start pricing",
    icon: FilePlus2,
    tone: "blue" as const,
  },
];

export function QuickCreate({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-mm-red px-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-mm-red-deep",
            compact && "size-11 px-0",
            className,
          )}
          aria-label={compact ? "Create" : undefined}
        >
          <Plus className="size-[18px]" strokeWidth={2} />
          {compact ? null : "Create"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-72 rounded-xl p-2 shadow-lg">
        <DropdownMenuLabel className="px-2 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-mist-400">
          Start a workflow
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {STARTS.map((item) => (
          <DropdownMenuItem key={item.href} asChild className="rounded-lg p-0 focus:bg-muted">
            <Link href={item.href} prefetch={false} className="flex min-h-16 items-center gap-3 px-2.5 py-2">
              <IconBadge icon={item.icon} tone={item.tone} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{item.label}</span>
                <span className="mt-0.5 block text-xs text-mist-400">{item.description}</span>
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
