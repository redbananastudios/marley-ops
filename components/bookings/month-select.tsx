"use client";

/**
 * Month dropdown for the provisional move window (Peter, 2026-08-14: "just a
 * month dropdown, no need for year"). Shows plain month names over a rolling
 * 12-month window starting this month, so each name appears exactly once and
 * the year is implied — picking "March" in August means next March. The value
 * stays "YYYY-MM" underneath, so storage and normaliseApproxMonth are
 * untouched. A stored month outside the window (reopening an old lead) is
 * kept as an extra option labelled with its year rather than silently lost.
 */

import { useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "none";

export function MonthSelect({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  /** "" | "YYYY-MM" | "YYYY-MM-01" (stored form). */
  value: string;
  onChange: (next: string) => void;
  className?: string;
}): React.JSX.Element {
  const current = value ? value.slice(0, 7) : "";
  // Lazy-init so the window is fixed for the life of the form (no hydration
  // wobble at a month boundary).
  const [start] = useState(() => new Date());
  const options = useMemo(() => {
    const list: { value: string; label: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      list.push({
        value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-GB", { month: "long" }),
      });
    }
    if (current && !list.some((o) => o.value === current)) {
      const d = new Date(`${current}-01T00:00:00`);
      list.unshift({
        value: current,
        label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      });
    }
    return list;
  }, [start, current]);

  return (
    <Select value={current || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder="Select month" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Not set</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
