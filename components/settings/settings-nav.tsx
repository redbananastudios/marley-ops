"use client";

/**
 * Sticky anchor-pill nav for the Settings page. Settings is one long scroll
 * (Team, AI, Pricing, Business, Margin, Health) — on an office iPad that's a lot
 * of thumb travel. These pills smooth-scroll to `id`-anchored sections and track
 * the one in view. Anchors (not tabs) keep deep links + browser Cmd-F working.
 *
 * Pills follow the sections' DOM/scroll order so the active marker moves
 * monotonically as you scroll; reordering the sections themselves was out of
 * scope for this pass.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSection {
  id: string;
  label: string;
}

export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  // Highlight the section currently crossing the upper band of the viewport.
  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Top ~25%–35% band is the "active" zone — a section becomes active as its
      // heading passes just under the sticky nav.
      { rootMargin: "-25% 0px -65% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  function go(id: string) {
    // scrollIntoView respects each section's scroll-margin-top, so it lands
    // below the sticky mobile header + this nav.
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  }

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-16 z-20 -mx-6 mb-6 border-b border-border bg-background px-6 py-2 md:-mx-8 md:px-8 xl:top-0"
    >
      <div className="flex gap-1.5 overflow-x-auto">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => go(s.id)}
            aria-current={active === s.id ? "true" : undefined}
            className={cn(
              "focus-ring inline-flex min-h-11 shrink-0 items-center rounded-pill border px-3.5 text-sm font-medium transition-colors",
              active === s.id
                ? "border-mm-red bg-mm-red text-white"
                : "border-border bg-card text-mist-500 hover:bg-muted hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
