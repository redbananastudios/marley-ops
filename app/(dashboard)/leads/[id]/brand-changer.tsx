"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import { updateLeadBrandAction } from "@/app/(dashboard)/leads/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * GATE 5 — the lead page's brand chip + small change-brand control (PRD §4
 * /leads/[id]). Follows the house pattern for small inline editors on this
 * page (status-changer.tsx): optimism-free — the server action decides, then
 * router.refresh() re-reads server truth; errors resync the tab.
 *
 * Rendered by the server page ONLY in multi-brand mode (single-brand
 * invariant, PRD §1). While no quote reference has been issued the chip is a
 * dropdown trigger; once one exists (`locked`) it renders static with the
 * tooltip explaining why — and the server action re-checks that gate anyway,
 * so a stale tab cannot slip a change through.
 *
 * Entirely data-driven: names and colours come from the caller's brands-table
 * rows, never from code.
 */
export function BrandChanger({
  leadId,
  current,
  options,
  locked,
}: {
  leadId: string;
  /** The lead's current brand row (BrandChipData shape). */
  current: BrandChipData;
  /** Active brands, in sort order — the choices offered. */
  options: BrandChipData[];
  /** True once ANY quote reference exists for this lead. */
  locked: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (locked) {
    return (
      <BrandChip
        brand={current}
        variant="eyebrow"
        title="Ref prefix is fixed once a quote reference is issued."
      />
    );
  }

  function pick(slug: string, name: string) {
    if (slug === current.slug) return;
    startTransition(async () => {
      try {
        const res = await updateLeadBrandAction(leadId, slug);
        if (res.ok) {
          toast.success(`Brand changed to ${name}`);
        } else {
          toast.error(res.error ?? "Could not change the brand");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change the brand");
      }
      // Success or failure, re-read server truth — a failure usually means
      // this tab was stale (e.g. a quote was just created in another window).
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isPending}>
        <button
          type="button"
          className="focus-ring inline-flex items-center gap-1 rounded-sm disabled:opacity-50"
          aria-label={`Change brand (currently ${current.name})`}
        >
          <BrandChip
            brand={current}
            variant="eyebrow"
            title="Change brand — available until a quote reference is issued"
          />
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin text-mist-400" strokeWidth={1.75} aria-label="Saving" />
          ) : (
            <ChevronDown className="size-3.5 text-mist-400" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((b) => (
          <DropdownMenuItem key={b.slug} onSelect={() => pick(b.slug, b.name)}>
            <BrandChip brand={b} size={16} />
            <span className="min-w-0 truncate">{b.name}</span>
            {b.slug === current.slug ? (
              <Check className="ml-auto size-4 text-mist-400" strokeWidth={1.75} aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
