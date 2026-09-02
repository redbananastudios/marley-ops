/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  ArrowLeft,
  Boxes,
  CalendarDays,
  Camera,
  CheckCircle2,
  MapPin,
  Package,
  PenLine,
  StickyNote,
  Truck,
  UserRound,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/app-sidebar";
import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  crewAssignedToAppointment,
  loadJobSheet,
  loadPhotoSignedUrls,
  loadSurveyVideoSignedUrls,
} from "@/lib/job-sheet-load";
import { loadJobNotesForAppointment } from "@/lib/job-notes";
import { jobDetailCompletion } from "@/lib/my-jobs/job-card";
import { JobNotes } from "@/components/crew/job-notes";
import type { JobSheetAddress } from "@/lib/job-sheet-docdef";
import { JobSheetButton } from "@/components/job-sheet-button";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { LastUpdated } from "@/components/pwa/last-updated";
import { CollectContractButton } from "@/components/crew/collect-contract-button";
import { CompleteJobButton } from "@/components/crew/complete-job-button";
import { CrewActionBar } from "@/components/crew/crew-action-bar";
import { CaptureFab } from "@/components/capture/capture-launchers";

/**
 * /my-jobs/[id] — the job sheet AS A WEB PAGE (Peter, 2026-07-10: "we should
 * have the details of the job sheet within the web page itself"). Same
 * price-free JobSheetData as the PDF, rendered phone-first for the van cab.
 * Photos come as short-lived signed URLs, not data URIs, to keep the page
 * light on mobile data.
 */

export const dynamic = "force-dynamic";

function fmtDate(d: string | null): string {
  if (!d) return "Date TBC";
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? "Date TBC"
    : t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function accessLine(a: JobSheetAddress): string {
  const bits = [a.propertyType, a.floor === "ground" ? "ground floor" : `floor: ${a.floor}`];
  if (a.lift === "yes") bits.push("lift");
  if (a.accessM > 0) bits.push(`carry ~${a.accessM}m`);
  return bits.filter(Boolean).join(" · ");
}

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return "";
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function videoLabel(v: { room: string | null; kind: "room_video" | "import_video" }): string {
  if (v.room) return v.room;
  return v.kind === "import_video" ? "Imported video" : "Room walkthrough";
}

export default async function CrewJobPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const admin = createAdminClient();

  // A crew member may only open jobs they're assigned to (matches the /my-jobs
  // listing gate); office roles review any job. This is what guards the signed
  // survey-media (photos + videos) minted below — never widen storage RLS.
  if (profile.role === "crew") {
    const assigned = await crewAssignedToAppointment(admin, profile.id, profile.email, id);
    if (!assigned) notFound();
  }

  const loaded = await loadJobSheet(admin, id);
  if (!loaded) notFound();
  const { data: d, apptType, apptStatus, surveyId, cubicSurveyId } = loaded;
  const [photos, videos, crewNotes, { data: completion }, { data: myStaff }] = await Promise.all([
    surveyId ? loadPhotoSignedUrls(admin, surveyId) : Promise.resolve([]),
    cubicSurveyId ? loadSurveyVideoSignedUrls(admin, cubicSurveyId) : Promise.resolve([]),
    loadJobNotesForAppointment(admin, id),
    admin
      .from("job_completions")
      .select("customer_name, customer_absent, crew_name, exceptions, signed_at, certificate_emailed_at")
      .eq("appointment_id", id)
      .maybeSingle(),
    admin.from("staff").select("full_name").eq("profile_id", profile.id).eq("is_active", true).maybeSingle(),
  ]);
  const isRemoval = apptType === "removal";
  // Completion keys on appointments.status FIRST — the same authority the
  // /my-jobs list uses — so an auto-completed job (no job_completions row)
  // reads as done here too instead of inviting a second sign-off.
  const completionState = jobDetailCompletion(apptStatus, !!completion);
  const jobClosed = completionState !== "none";
  const fromLine = [d.from.address, d.from.postcode].filter(Boolean).join(", ");
  const toLine = [d.to.address, d.to.postcode].filter(Boolean).join(", ");

  const eyebrow = (icon: React.ReactNode, text: string) => (
    <p className="eyebrow flex items-center gap-1.5">
      {icon}
      {text}
    </p>
  );

  // Baked render time → honest "last updated" when this page is served from the
  // offline cache (A2).
  const fetchedAt = new Date().toISOString();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 sm:px-5">
        <BrandMark compact />
        <SignOutButton />
      </header>

      <main className="mx-auto max-w-2xl p-4 pb-28 sm:p-5 sm:pb-28 md:p-8 md:pb-28">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/my-jobs"
            className="focus-ring inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-mist-500 hover:text-foreground"
          >
            <ArrowLeft className="size-4" strokeWidth={1.75} />
            My jobs
          </Link>
          <LastUpdated at={fetchedAt} />
        </div>

        {/* headline */}
        <div className="mt-2 rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-5">
          <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The pill on the right already says Move/Survey — the eyebrow names
                the surface (this page is the digital job sheet) + the quote ref. */}
            <p className="eyebrow">Job sheet{d.quoteRef ? ` · ${d.quoteRef}` : ""}</p>
            <h1 className="mt-1 font-display text-3xl font-bold text-foreground">{d.customerName}</h1>
            <p className="mt-1 text-sm text-mist-500">
              {fmtDate(d.moveDate)} · {d.timeWindow}
              {d.days > 1 ? ` · ${d.days}-day job` : ""}
            </p>
          </div>
          <span
            className={
              "mt-1 shrink-0 rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide " +
              (isRemoval ? "bg-mm-red text-white" : "bg-muted text-mist-500")
            }
          >
            {isRemoval ? "Move" : "Survey"}
          </span>
          </div>
        </div>

        {/* contract flag — never gates the move, but the crew can't miss it */}
        {isRemoval && !jobClosed && d.contractSigned === false ? (
          <div className="mt-4 rounded-md border border-warn-border bg-warn-bg p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-warn">
              <PenLine className="size-4 shrink-0" strokeWidth={2} />
              Contract not signed yet — collect the customer&apos;s signature on arrival.
            </p>
            <div className="mt-3">
              <CollectContractButton appointmentId={id} customerName={d.customerName} />
            </div>
          </div>
        ) : null}

        {/* completed state */}
        {completion ? (
          <div className="mt-4 rounded-md border border-success-border bg-success-bg p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-success">
              <CheckCircle2 className="size-4 shrink-0" strokeWidth={2} />
              Job completed —{" "}
              {completion.customer_absent
                ? `signed by crew lead ${completion.crew_name} (customer not present)`
                : `signed by ${completion.customer_name} and ${completion.crew_name}`}
            </p>
            <p className="mt-1 text-xs text-success/80">
              {completion.exceptions?.trim()
                ? `Exceptions noted: ${completion.exceptions.trim()}`
                : "Nothing to report."}
              {completion.certificate_emailed_at ? " Certificate emailed to the customer." : ""}
            </p>
          </div>
        ) : completionState === "auto" ? (
          <div className="mt-4 rounded-md border border-success-border bg-success-bg p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-success">
              <CheckCircle2 className="size-4 shrink-0" strokeWidth={2} />
              Job completed — closed out by the office.
            </p>
            <p className="mt-1 text-xs text-success/80">Nothing left to do here — no crew sign-off needed.</p>
          </div>
        ) : null}

        {/* document action — Call + Complete live in the sticky cab bar below */}
        {isRemoval ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <JobSheetButton appointmentId={id} fileHint={d.customerName} />
          </div>
        ) : null}

        {/* route — each address is tap-to-navigate for the van cab */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["Moving from", d.from],
              ["Moving to", d.to],
            ] as const
          ).map(([title, side]) => {
            const dest = [side.address, side.postcode].filter(Boolean).join(", ");
            return (
              <div key={title} className="rounded-lg border border-border bg-card p-4">
                {eyebrow(<MapPin className="size-3.5" strokeWidth={1.75} />, title)}
                {/* no street on file → lead with the postcode rather than a "—" line */}
                {side.address ? <p className="mt-1.5 text-sm font-medium text-foreground">{side.address}</p> : null}
                {side.postcode ? (
                  <p className={cn("tabular text-sm font-semibold text-foreground", !side.address && "mt-1.5")}>{side.postcode}</p>
                ) : null}
                {!side.address && !side.postcode ? <p className="mt-1.5 text-sm text-mist-400">No address on file</p> : null}
                {accessLine(side) ? <p className="mt-1 text-xs capitalize text-mist-400">{accessLine(side)}</p> : null}
                {dest ? (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring mt-2.5 inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    <MapPin className="size-4" strokeWidth={1.75} />
                    Directions
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* vehicles + crew */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            {eyebrow(<Truck className="size-3.5" strokeWidth={1.75} />, "Vehicles")}
            {d.vehicleLabel ? <p className="mt-1.5 text-sm font-medium text-foreground">{d.vehicleLabel}</p> : null}
            {d.packingLabel ? <p className="text-xs text-mist-400">{d.packingLabel}</p> : null}
            <ul className="mt-2 space-y-1 text-sm text-foreground">
              {d.vehicles.length ? (
                d.vehicles.map((v) => <li key={v}>{v}</li>)
              ) : (
                <li className="text-mist-400">No vehicles assigned yet — the office will assign them; call the office if this is still empty on the morning of the move.</li>
              )}
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            {eyebrow(<UserRound className="size-3.5" strokeWidth={1.75} />, "Crew")}
            <ul className="mt-1.5 space-y-1 text-sm text-foreground">
              {d.crew.length ? (
                d.crew.map((c) => <li key={c}>{c}</li>)
              ) : (
                <li className="text-mist-400">No crew assigned yet — the office will assign them; call the office if this is still empty on the morning of the move.</li>
              )}
            </ul>
          </div>
        </div>

        {/* inventory */}
        <div className="mt-3 rounded-lg border border-border bg-card">
          <div className="border-b px-4 py-3">
            {eyebrow(<Package className="size-3.5" strokeWidth={1.75} />, "Packing materials / inventory")}
          </div>
          {d.items.length === 0 ? (
            <p className="px-4 py-5 text-sm text-mist-400">No packing materials on the accepted quote.</p>
          ) : (
            <ul className="divide-y">
              {d.items.map((i) => (
                <li key={i.label} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-foreground">{i.label}</span>
                  <span className="tabular font-semibold text-foreground">{i.qty}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* survey inventory — the full room-grouped item list the survey
            collected, price-free; notMoving lines stay in, clearly flagged */}
        {d.surveyInventory?.length ? (
          <div className="mt-3 rounded-lg border border-border bg-card">
            <div className="border-b px-4 py-3">
              {eyebrow(<Boxes className="size-3.5" strokeWidth={1.75} />, "Survey inventory")}
            </div>
            <div className="divide-y">
              {d.surveyInventory.map((room) => (
                <div key={room.room} className="px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">{room.room}</p>
                  <ul className="mt-1.5 space-y-1.5">
                    {room.items.map((it, i) => (
                      <li key={`${it.title}-${i}`} className="text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-foreground">
                            {it.title}
                            {it.qty > 1 ? <span className="text-mist-400"> ×{it.qty}</span> : null}
                          </span>
                          {it.ft3 ? <span className="tabular shrink-0 text-xs text-mist-400">{it.ft3} ft³</span> : null}
                        </div>
                        {it.flags.notMoving || it.flags.dismantle || it.flags.fragile ? (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {it.flags.notMoving ? (
                              <span className="rounded-pill bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                                Not moving — leave in place
                              </span>
                            ) : null}
                            {it.flags.dismantle ? (
                              <span className="rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-mist-500">
                                Dismantle
                              </span>
                            ) : null}
                            {it.flags.fragile ? (
                              <span className="rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-mist-500">
                                Fragile
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {it.note ? <p className="mt-0.5 text-xs text-mist-400">{it.note}</p> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* notes */}
        {d.volumeLine || d.accessNotes || d.largeItemsNotes || d.jobNotes ? (
          <div className="mt-3 rounded-lg border border-border bg-card p-4">
            {eyebrow(<StickyNote className="size-3.5" strokeWidth={1.75} />, "Notes")}
            <div className="mt-1.5 space-y-1.5 text-sm text-foreground">
              {d.volumeLine ? <p className="font-medium">{d.volumeLine}</p> : null}
              {d.accessNotes ? (
                <p>
                  <span className="text-mist-400">Access:</span> {d.accessNotes}
                </p>
              ) : null}
              {d.largeItemsNotes ? (
                <p>
                  <span className="text-mist-400">Large items:</span> {d.largeItemsNotes}
                </p>
              ) : null}
              {d.jobNotes ? <p>{d.jobNotes}</p> : null}
            </div>
          </div>
        ) : null}

        {/* survey photos */}
        {photos.length ? (
          <div className="mt-3 rounded-lg border border-border bg-card p-4">
            {eyebrow(<Camera className="size-3.5" strokeWidth={1.75} />, "Survey photos")}
            <div className="mt-2 grid grid-cols-2 gap-2">
              {photos.map((p, i) => (
                <a key={i} href={p.url} target="_blank" rel="noreferrer" className="group block">
                  <img
                    src={p.url}
                    alt={p.caption || p.label}
                    className="aspect-[4/3] w-full rounded-md border border-border object-cover"
                    loading="lazy"
                  />
                  <p className="mt-1 truncate text-xs text-mist-400">
                    {p.label}
                    {p.caption ? ` — ${p.caption}` : ""}
                  </p>
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {/* survey walkthrough videos — the clips the survey captured, played
            inline in the cab; signed URLs minted per request, office-only bucket */}
        {videos.length ? (
          <div className="mt-3 rounded-lg border border-border bg-card p-4">
            {eyebrow(<Video className="size-3.5" strokeWidth={1.75} />, "Survey videos")}
            <div className="mt-2 space-y-4">
              {videos.map((v, i) => {
                const dur = fmtDuration(v.durationS);
                return (
                  <div key={i}>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-foreground">{videoLabel(v)}</span>
                      {dur ? <span className="tabular shrink-0 text-xs text-mist-400">{dur}</span> : null}
                    </div>
                    <video
                      controls
                      preload="none"
                      playsInline
                      src={v.url}
                      className="w-full rounded-md border border-border bg-black"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* crew notes + photos — damage, access issues, internal records */}
        <JobNotes appointmentId={id} notes={crewNotes} currentProfileId={profile.id} />

        <div className="mt-4 flex items-center gap-1.5 text-xs text-mist-400">
          <CalendarDays className="size-3.5" strokeWidth={1.75} />
          If anything on this job looks wrong, call the office before setting off.
        </div>
      </main>

      {/* job content capture — floats above the pinned bar (thumb zone) */}
      <CaptureFab anchor={{ appointmentId: id }} />

      {/* one-handed cab actions — pinned so they never scroll away */}
      <CrewActionBar
        phone={d.customerPhone}
        firstName={d.customerName.split(" ")[0]}
        directionsTo={fromLine || toLine || null}
      >
        {isRemoval && !jobClosed ? (
          <CompleteJobButton
            job={{
              appointmentId: id,
              customerName: d.customerName,
              quoteRef: d.quoteRef,
              moveDate: d.moveDate,
              fromLine,
              toLine,
              crewNameDefault: myStaff?.full_name ?? profile.full_name ?? "",
              // The job's brand rides on the sheet data (null = default brand),
              // so the on-device certificate renders the right identity.
              brand: d.brand ?? null,
            }}
            triggerClassName="focus-ring inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:bg-mm-red-deep"
          />
        ) : null}
      </CrewActionBar>
    </div>
  );
}
