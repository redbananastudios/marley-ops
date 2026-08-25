"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Office review list for captured job content (PRD v1.0 §5) — thumbnails with
 * play/lightbox, transcripts under voice notes, and the APPROVAL GATE: nothing
 * reaches marketing until the office taps Approve (Peter approves initially).
 * Internal-only jobs show a lock — the action refuses them server-side too.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Camera, Loader2, Lock, Mic, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import { approveJobMediaAction, deleteJobMediaAction } from "@/app/actions/job-media";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";

export interface JobMediaView {
  id: string;
  kind: "photo" | "video" | "audio";
  url: string; // signed
  caption: string;
  tag: string | null;
  consentState: string;
  transcript: string | null;
  transcriptStatus: string;
  capturedByName: string;
  createdAt: string;
  approvedAt: string | null;
  leadId: string;
  leadName: string | null;
  quoteRef?: string | null;
}

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });

function KindIcon({ kind }: { kind: JobMediaView["kind"] }) {
  const Icon = kind === "photo" ? Camera : kind === "video" ? Video : Mic;
  return <Icon className="size-3.5" strokeWidth={1.75} />;
}

export function JobMediaList({
  items,
  showJobLink = false,
  brands = [],
  brandByLead,
}: {
  items: JobMediaView[];
  showJobLink?: boolean;
  /** Active brands (multi-brand PRD §4) — slim chip data. Empty or absent in
   *  single-brand mode / when the ?brand= filter names one brand, and the
   *  chips render nothing (the single-brand invariant, PRD §1). */
  brands?: BrandChipData[];
  /** leadId → brand slug for the rows on screen. */
  brandByLead?: Record<string, string>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const brandBySlug = new Map(brands.map((b) => [b.slug, b]));

  const act = (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusyId(id);
    start(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.ok) toast.error(res.error ?? "Something went wrong.");
      else {
        toast.success(okMsg);
        router.refresh();
      }
    });
  };

  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-mist-400">
        Nothing captured yet. Crew and estimators capture photos, video and voice notes from the job
        page — everything lands here for review, and only approved items ever reach marketing.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {items.map((m) => {
        const internalOnly = m.consentState === "internal_only";
        const busy = busyId === m.id;
        // Brand chip — beside the job link (multi-brand PRD §4 Content).
        const chipBrand = brandByLead ? brandBySlug.get(brandByLead[m.leadId] ?? "") : undefined;
        return (
          <li key={m.id} className="flex gap-3 px-4 py-3">
            <a
              href={m.url}
              target="_blank"
              rel="noreferrer"
              className="relative block size-24 shrink-0 overflow-hidden rounded-md border bg-muted"
            >
              {m.kind === "photo" ? (
                <img src={m.url} alt={m.caption || "Job photo"} className="size-full object-cover" loading="lazy" />
              ) : m.kind === "video" ? (
                <video src={m.url} muted playsInline preload="none" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-mist-400">
                  <Mic className="size-8" strokeWidth={1.5} />
                </span>
              )}
            </a>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mist-400">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <KindIcon kind={m.kind} />
                  {m.kind === "audio" ? "Voice note" : m.kind === "photo" ? "Photo" : "Video"}
                </span>
                {m.tag ? <span className="rounded-full border px-2 py-0.5 capitalize">{m.tag}</span> : null}
                <span>
                  {m.capturedByName} · {fmtAt(m.createdAt)}
                </span>
                {showJobLink ? (
                  <a href={`/leads/${m.leadId}`} className="text-mm-red hover:underline">
                    {m.leadName ?? "Open job"}
                  </a>
                ) : null}
                {chipBrand ? <BrandChip brand={chipBrand} size={16} /> : null}
              </div>
              {m.caption ? <p className="mt-1 text-sm text-foreground">{m.caption}</p> : null}
              {m.kind === "audio" ? (
                <div className="mt-1.5 space-y-1.5">
                  <audio src={m.url} controls preload="none" className="h-9 w-full max-w-sm" />
                  {m.transcript ? (
                    <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm text-foreground">
                      {m.transcript}
                    </p>
                  ) : (
                    <p className="text-xs text-mist-400">
                      {m.transcriptStatus === "failed"
                        ? "Transcript failed — the audio still plays."
                        : "Transcript on its way (a few minutes)…"}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {internalOnly ? (
                  <span className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-muted px-3 text-xs font-medium text-mist-400">
                    <Lock className="size-3.5" strokeWidth={1.75} />
                    Internal only — customer hasn&apos;t OK&apos;d marketing use
                  </span>
                ) : m.approvedAt ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(m.id, () => approveJobMediaAction(m.id, false), "Approval removed.")}
                    className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-success-bg px-3 text-xs font-semibold text-success"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" strokeWidth={2} />}
                    Approved for marketing — tap to undo
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(m.id, () => approveJobMediaAction(m.id, true), "Approved for marketing.")}
                    className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-xs font-semibold text-white hover:bg-mm-red-deep"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" strokeWidth={2} />}
                    Approve for marketing
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Delete"
                  onClick={() => {
                    if (window.confirm("Delete this item for good? The file is removed too.")) {
                      act(m.id, () => deleteJobMediaAction(m.id), "Deleted.");
                    }
                  }}
                  className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input px-3 text-xs font-medium text-mist-400 hover:text-danger"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
