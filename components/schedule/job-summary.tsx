"use client";

/**
 * Diary job summary — the office's at-a-glance brief for a removal or packing
 * day, on the appointment view modal (Peter, 2026-08-18: "display more data
 * related to the move such as what the crew need to bring… an easy to read
 * summary view" with the full detail one tap away on the quote).
 *
 * Reads the SAME price-free assembler as the crew sheets (getJobSummaryAction →
 * loadJobSheet), so what the office sees here and what the crew hold in the van
 * can never drift. Money deliberately stays off this panel — the "View full
 * quote" link is where the numbers live.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, Loader2, PackageOpen, Users, DoorOpen, StickyNote, PenLine } from "lucide-react";
import { getJobSummaryAction } from "@/app/actions/job-sheet";
import { accessLine } from "@/lib/job-sheet-data";
import type { JobSheetData } from "@/lib/job-sheet-docdef";

const label = "flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase";
const chip = "rounded-pill bg-card px-2.5 py-1 text-xs font-medium text-foreground ring-1 ring-border";

function NoteRow({ title, text }: { title: string; text: string | null | undefined }) {
  if (!text?.trim()) return null;
  return (
    <div className="text-sm">
      <span className="font-semibold text-foreground">{title}: </span>
      <span className="whitespace-pre-wrap text-mist-500">{text.trim()}</span>
    </div>
  );
}

export function JobSummary({
  appointmentId,
  apptNotes,
  open,
}: {
  appointmentId: string;
  /** The diary entry's own notes (what "Edit → Job notes" edits). */
  apptNotes: string | null;
  open: boolean;
}) {
  // Result keyed by appointment id — "loading" is DERIVED (no result for the
  // current id yet), so opening a different job never needs a reset effect and
  // a late response for the old one can't paint the new one's panel.
  const [loaded, setLoaded] = useState<{
    key: string;
    result: { data: JobSheetData; quoteId: string | null } | "error";
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    const key = appointmentId;
    getJobSummaryAction(appointmentId)
      .then((r) => {
        if (stale) return;
        setLoaded({ key, result: r.ok ? { data: r.data, quoteId: r.quoteId } : "error" });
      })
      .catch(() => {
        if (!stale) setLoaded({ key, result: "error" });
      });
    return () => {
      stale = true;
    };
  }, [open, appointmentId]);

  const state =
    loaded?.key !== appointmentId
      ? ({ kind: "loading" } as const)
      : loaded.result === "error"
        ? ({ kind: "error" } as const)
        : ({ kind: "ready", ...loaded.result } as const);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-mist-400">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
        Pulling the job details…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-mist-400">
        Couldn&apos;t load the job summary — the quote page has the full details.
      </div>
    );
  }

  const { data, quoteId } = state;
  const fromLine = accessLine(data.from);
  const toLine = accessLine(data.to);
  const facts = [
    `${data.days}-day job`,
    data.vehicleLabel || null,
    data.quoteRef ? data.packingLabel : null,
    data.volumeLine || null,
  ].filter(Boolean) as string[];

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={label}>
          <PackageOpen className="size-3.5" strokeWidth={2} />
          Job summary
        </p>
        {quoteId ? (
          <Link
            href={`/quotes/${quoteId}`}
            prefetch={false}
            className="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <FileText className="size-3.5 text-mm-red" strokeWidth={1.75} />
            View full quote{data.quoteRef ? ` (${data.quoteRef})` : ""}
          </Link>
        ) : null}
      </div>

      {/* headline facts */}
      <div className="flex flex-wrap items-center gap-1.5">
        {facts.map((f) => (
          <span key={f} className={chip}>
            {f}
          </span>
        ))}
        {data.contractSigned === false ? (
          <span className="rounded-pill bg-mm-red-tint px-2.5 py-1 text-xs font-semibold text-mm-red">
            Contract to collect on arrival
          </span>
        ) : null}
      </div>

      {!data.quoteRef ? (
        <p className="text-xs text-mist-400">No accepted quote on this job — details below come from the lead.</p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {/* who's on it */}
        <div className="min-w-0">
          <p className={`${label} mb-1.5`}>
            <Users className="size-3.5" strokeWidth={2} />
            Crew &amp; vans
          </p>
          {data.crew.length ? (
            <p className="text-sm text-foreground">{data.crew.join(", ")}</p>
          ) : (
            <p className="text-sm text-mist-400">No crew assigned yet.</p>
          )}
          {data.vehicles.length ? (
            <p className="mt-0.5 text-sm text-mist-500">{data.vehicles.join(", ")}</p>
          ) : (
            <p className="mt-0.5 text-sm text-mist-400">No vehicles assigned yet.</p>
          )}
        </div>

        {/* what to bring */}
        <div className="min-w-0">
          <p className={`${label} mb-1.5`}>
            <PackageOpen className="size-3.5" strokeWidth={2} />
            Packing materials
          </p>
          {data.items.length ? (
            <ul className="grid gap-0.5">
              {data.items.map((i) => (
                <li key={i.label} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-foreground">{i.label}</span>
                  <span className="tabular font-semibold text-foreground">{i.qty}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-mist-400">{data.quoteRef ? "None on the quote." : "No quote to read them from."}</p>
          )}
        </div>

        {/* getting in at both ends */}
        <div className="min-w-0">
          <p className={`${label} mb-1.5`}>
            <DoorOpen className="size-3.5" strokeWidth={2} />
            Access
          </p>
          {fromLine || toLine ? (
            <div className="grid gap-1 text-sm">
              {fromLine ? (
                <p>
                  <span className="font-semibold text-foreground">From:</span>{" "}
                  <span className="text-mist-500">{fromLine}</span>
                </p>
              ) : null}
              {toLine ? (
                <p>
                  <span className="font-semibold text-foreground">To:</span>{" "}
                  <span className="text-mist-500">{toLine}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-mist-400">No access details recorded.</p>
          )}
        </div>
      </div>

      {/* the words that matter — each source named so nothing wears the wrong hat */}
      {apptNotes?.trim() || data.accessNotes || data.largeItemsNotes || data.quoteNotes ? (
        <div className="grid gap-1.5 border-t border-border pt-2.5">
          <p className={label}>
            <StickyNote className="size-3.5" strokeWidth={2} />
            Notes
          </p>
          <NoteRow title="Job notes" text={apptNotes} />
          <NoteRow title="Access" text={data.accessNotes} />
          <NoteRow title="Large items" text={data.largeItemsNotes} />
          <NoteRow title="Quote notes" text={data.quoteNotes} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-border pt-2.5 text-xs text-mist-400">
          <PenLine className="size-3.5" strokeWidth={1.75} />
          No job notes yet — add them with Edit.
        </div>
      )}
    </div>
  );
}
