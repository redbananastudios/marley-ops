"use client";

/**
 * Public crew sign-up — the office side. Two pieces, both rendered on the
 * Staff tab of Staff & Fleet (admin only):
 *  - CrewSignupCard: the shared /join/<token> link with copy, an on/off
 *    switch and a "New link" regenerate (kills the old link).
 *  - SubmissionsReview: pending staff_submissions with Approve (into staff)
 *    / Reject. Reviewed rows drop out of the list.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, Link2, Loader2, RefreshCw, UserRoundPlus, XCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  approveStaffSubmissionAction,
  regenerateStaffOnboardTokenAction,
  rejectStaffSubmissionAction,
  setStaffOnboardEnabledAction,
} from "@/app/(dashboard)/resources/actions";
import { ageFromDob } from "@/lib/staff/onboarding";

export interface StaffSubmissionRow {
  id: string;
  full_name: string;
  date_of_birth: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  is_driver: boolean;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  notes: string | null;
  created_at: string;
}

function fmtSubmitted(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/* ------------------------------------------------------------ link card */

export function CrewSignupCard({
  enabled,
  token,
  baseUrl,
}: {
  enabled: boolean;
  token: string | null;
  baseUrl: string;
}) {
  const router = useRouter();
  const [toggling, setToggling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const origin = baseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const url = token ? `${origin}/join/${token}` : null;

  async function toggle(next: boolean) {
    setToggling(true);
    const res = await setStaffOnboardEnabledAction(next);
    setToggling(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(next ? "Crew sign-up link is live." : "Crew sign-up link switched off.");
    router.refresh();
  }

  async function regenerate() {
    if (
      !window.confirm(
        "Make a new sign-up link? The old link stops working immediately - anyone still holding it will see a dead-link page.",
      )
    ) {
      return;
    }
    setRegenerating(true);
    const res = await regenerateStaffOnboardTokenAction();
    setRegenerating(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("New link created. The old one is dead.");
    router.refresh();
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      toast.success("Sign-up link copied.");
    } catch {
      window.prompt("Copy the sign-up link:", url);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-mist-400" strokeWidth={1.75} />
          <p className="text-sm font-semibold text-foreground">Crew sign-up link</p>
          <span
            className={cn(
              "rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              enabled ? "bg-success-bg text-success" : "bg-muted text-mist-400",
            )}
          >
            {enabled ? "Live" : "Off"}
          </span>
        </div>
        <label className="relative inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            role="switch"
            aria-label="Crew sign-up link enabled"
            className="peer sr-only"
            checked={enabled}
            disabled={toggling}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="h-7 w-12 rounded-full bg-mist-200 transition-colors peer-checked:bg-mm-red" />
          <span className="absolute left-1 size-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
        </label>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-mist-400">
        One shared link for the crew WhatsApp group. Each person fills in their own details and they land
        below for review. Switch it off when you are not recruiting.
      </p>

      {url ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="tabular min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-foreground">
            {url}
          </code>
          <Button type="button" variant="outline" onClick={copy}>
            {copied ? <Check className="size-4 text-success" strokeWidth={2} /> : <Link2 className="size-4" strokeWidth={1.75} />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button type="button" variant="outline" onClick={regenerate} disabled={regenerating}>
            {regenerating ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <RefreshCw className="size-4" strokeWidth={1.75} />
            )}
            New link
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-mist-400">The link is created the first time you switch this on.</p>
      )}
    </div>
  );
}

/* --------------------------------------------------------- review queue */

export function SubmissionsReview({ submissions }: { submissions: StaffSubmissionRow[] }) {
  if (submissions.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <UserRoundPlus className="size-4 text-mist-400" strokeWidth={1.75} />
        <p className="text-sm font-semibold text-foreground">Sign-ups to review ({submissions.length})</p>
      </div>
      <div className="mt-3 grid gap-3">
        {submissions.map((s) => (
          <SubmissionCard key={s.id} s={s} />
        ))}
      </div>
    </div>
  );
}

function SubmissionCard({ s }: { s: StaffSubmissionRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const age = s.date_of_birth ? ageFromDob(s.date_of_birth) : null;

  async function run(kind: "approve" | "reject") {
    if (kind === "reject" && !window.confirm(`Reject ${s.full_name}'s sign-up? They are not told - the entry just leaves the queue.`)) {
      return;
    }
    setBusy(kind);
    let res = kind === "approve" ? await approveStaffSubmissionAction(s.id) : await rejectStaffSubmissionAction(s.id);
    // Two-step update guard: the sign-up matches an EXISTING staff record, so
    // approving updates that record rather than creating someone new — the
    // admin sees who before anything is written.
    if (kind === "approve" && !res.ok && "needsConfirm" in res && res.needsConfirm) {
      const { staffId, staffName } = res.needsConfirm;
      if (window.confirm(`This sign-up matches the existing staff record for ${staffName}. Approving UPDATES their record with the submitted details. Continue?`)) {
        res = await approveStaffSubmissionAction(s.id, staffId);
      } else {
        setBusy(null);
        return;
      }
    }
    setBusy(null);
    if (!res.ok) {
      toast.error("error" in res && res.error ? res.error : "Could not review the sign-up.");
      return;
    }
    const updated = kind === "approve" && "updatedExisting" in res ? res.updatedExisting : null;
    toast.success(kind === "approve" ? (updated ? `${updated}'s staff record updated.` : `${s.full_name} added to staff.`) : "Sign-up rejected.");
    router.refresh();
  }

  const detail: [string, string | null][] = [
    ["Age", age != null ? `${age} (born ${s.date_of_birth})` : null],
    ["Phone", s.phone],
    ["Email", s.email],
    ["Address", s.address],
    [
      "Emergency contact",
      s.emergency_contact_name || s.emergency_contact_phone
        ? [s.emergency_contact_name, s.emergency_contact_phone].filter(Boolean).join(" · ")
        : null,
    ],
    ["Notes", s.notes],
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="truncate">{s.full_name}</span>
            <span
              className={cn(
                "shrink-0 rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                s.is_driver ? "bg-success-bg text-success" : "bg-muted text-mist-400",
              )}
            >
              {s.is_driver ? "Driver" : "Not a driver"}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-mist-400">Submitted {fmtSubmitted(s.created_at)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            onClick={() => run("approve")}
            disabled={busy !== null}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {busy === "approve" ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <CheckCircle2 className="size-4" strokeWidth={1.75} />
            )}
            Approve
          </Button>
          <Button type="button" variant="outline" onClick={() => run("reject")} disabled={busy !== null}>
            {busy === "reject" ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <XCircle className="size-4" strokeWidth={1.75} />
            )}
            Reject
          </Button>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {detail
          .filter(([, val]) => val)
          .map(([label, val]) => (
            <div key={label} className="flex min-w-0 gap-2">
              <dt className="shrink-0 font-semibold uppercase tracking-[0.1em] text-[10px] leading-5 text-mist-400">
                {label}
              </dt>
              <dd className="min-w-0 break-words text-mist-500">{val}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
