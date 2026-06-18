"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { CHANNEL_LABELS } from "@/lib/leads/schema";

const ALL = "all";

export function LeadsFilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tab = searchParams.get("tab") === "web" ? "web" : "all";
  const status = searchParams.get("status") ?? "";
  const channel = searchParams.get("channel") ?? "";

  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the local input in sync when the URL changes externally (tab toggle, etc.).
  useEffect(() => {
    setSearch(searchParams.get("q") ?? "");
  }, [searchParams]);

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams((params) => {
        const trimmed = value.trim();
        if (trimmed) params.set("q", trimmed);
        else params.delete("q");
      });
    }, 300);
  };

  const onStatusChange = (value: string) => {
    pushParams((params) => {
      if (value === ALL) params.delete("status");
      else params.set("status", value);
    });
  };

  const onChannelChange = (value: string) => {
    pushParams((params) => {
      if (value === ALL) params.delete("channel");
      else params.set("channel", value);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400"
        />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search name, phone, email, postcode"
          className="pl-9"
          aria-label="Search leads"
        />
      </div>

      <Select value={status || ALL} onValueChange={onStatusChange}>
        <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by status">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {LEAD_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {LEAD_STATUS_META[s].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={channel || ALL}
        onValueChange={onChannelChange}
        disabled={tab === "web"}
      >
        <SelectTrigger className="h-9 w-[170px]" aria-label="Filter by channel">
          <SelectValue placeholder="All channels" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All channels</SelectItem>
          {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
