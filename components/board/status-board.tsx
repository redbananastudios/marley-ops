"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoveHorizontal } from "lucide-react";
import { toast } from "sonner";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { CHANNEL_LABELS } from "@/lib/leads/schema";
import { updateLeadStatusAction } from "@/app/(dashboard)/leads/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Lead = {
  id: string;
  name: string | null;
  status: string;
  entry_channel: string;
  from_postcode: string | null;
  to_postcode: string | null;
};

const STATUSES = LEAD_STATUSES as string[];

/** Stable column order: the design's 7 statuses, with "declined" forced last. */
const COLUMN_ORDER = [
  ...STATUSES.filter((s) => s !== "declined"),
  ...STATUSES.filter((s) => s === "declined"),
];

function subLine(lead: Lead): string {
  const channel = CHANNEL_LABELS[lead.entry_channel] ?? lead.entry_channel.replace(/_/g, " ");
  const f = lead.from_postcode?.trim();
  const t = lead.to_postcode?.trim();
  let route = "no postcodes";
  if (f && t) route = `${f}→${t}`;
  else if (f) route = `from ${f}`;
  else if (t) route = `to ${t}`;
  return `${channel} · ${route}`;
}

export function StatusBoard({ leads: initialLeads }: { leads: Lead[] }) {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  async function move(leadId: string, toStatus: string) {
    const current = leads.find((l) => l.id === leadId);
    if (!current || current.status === toStatus) return;
    const fromStatus = current.status;

    // optimistic
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: toStatus } : l)));

    const res = await updateLeadStatusAction(leadId, toStatus);
    if (res.ok) {
      toast.success(`Moved to ${LEAD_STATUS_META[toStatus]?.label ?? toStatus}`);
      router.refresh();
    } else {
      // revert
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: fromStatus } : l)));
      toast.error(res.error ?? "Could not move lead");
    }
  }

  return (
    <div className="-mx-6 overflow-x-auto px-6 pb-2 md:-mx-8 md:px-8">
      <div className="flex min-w-max gap-4">
        {COLUMN_ORDER.map((status) => {
          const meta = LEAD_STATUS_META[status];
          const columnLeads = leads.filter((l) => l.status === status);
          const isTarget = dropTarget === status;

          return (
            <section
              key={status}
              onDragOver={(e) => {
                e.preventDefault();
                if (dropTarget !== status) setDropTarget(status);
              }}
              onDragLeave={(e) => {
                // only clear if we actually left the column, not a child
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget((t) => (t === status ? null : t));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const leadId = e.dataTransfer.getData("text/plain") || draggingId;
                setDropTarget(null);
                setDraggingId(null);
                if (leadId) void move(leadId, status);
              }}
              className={cn(
                "flex w-72 shrink-0 flex-col rounded-md border bg-card transition-colors",
                isTarget && "border-dashed border-mm-red bg-accent",
              )}
            >
              <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                <span className="text-sm font-semibold text-foreground">
                  {meta?.label ?? status}
                </span>
                <span className="inline-flex min-w-6 items-center justify-center rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
                  {columnLeads.length}
                </span>
              </header>

              <div className="flex flex-1 flex-col gap-2 p-2">
                {columnLeads.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-mist-400">No leads.</p>
                ) : (
                  columnLeads.map((lead) => (
                    <article
                      key={lead.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", lead.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingId(lead.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropTarget(null);
                      }}
                      className={cn(
                        "group flex cursor-grab items-start gap-2 rounded-md border bg-card p-3 active:cursor-grabbing",
                        draggingId === lead.id && "opacity-50",
                      )}
                    >
                      <Link href={`/leads/${lead.id}`} className="block min-w-0 flex-1">
                        <span className="block truncate font-semibold text-foreground">
                          {lead.name ?? "—"}
                        </span>
                        <span className="block truncate text-xs text-mist-400">
                          {subLine(lead)}
                        </span>
                      </Link>

                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label="Move lead"
                          className="-mr-1 -mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground focus-visible:outline-none"
                        >
                          <MoveHorizontal strokeWidth={1.75} className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel>Move to</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {COLUMN_ORDER.filter((s) => s !== status).map((s) => (
                            <DropdownMenuItem
                              key={s}
                              onSelect={() => void move(lead.id, s)}
                            >
                              {LEAD_STATUS_META[s]?.label ?? s}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </article>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
