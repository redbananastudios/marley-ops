"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SyncResult {
  ok: boolean;
  synced?: number;
  inserted?: number;
  updated?: number;
  error?: string;
}

export function SyncLeadsButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSync() {
    setLoading(true);
    try {
      const res = await fetch("/api/sync/sanity-leads");
      const data = (await res.json()) as SyncResult;

      if (data.ok) {
        toast.success(`Synced ${data.synced ?? 0} (${data.inserted ?? 0} new)`);
        router.refresh();
      } else {
        toast.error(data.error ?? "Sync failed");
      }
    } catch {
      toast.error("Sync failed — could not reach the sync endpoint");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" onClick={handleSync} disabled={loading}>
      <RefreshCw
        strokeWidth={1.75}
        className={cn(loading && "animate-spin")}
      />
      Sync website leads
    </Button>
  );
}
