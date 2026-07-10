/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  ArrowLeft,
  CalendarDays,
  Camera,
  CheckCircle2,
  MapPin,
  Package,
  PenLine,
  Phone,
  StickyNote,
  Truck,
  UserRound,
} from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadJobSheet, loadPhotoSignedUrls } from "@/lib/job-sheet-load";
import type { JobSheetAddress } from "@/lib/job-sheet-docdef";
import { JobSheetButton } from "@/components/job-sheet-button";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { CollectContractButton } from "@/components/crew/collect-contract-button";
import { CompleteJobButton } from "@/components/crew/complete-job-button";

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

export default async function CrewJobPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  const admin = createAdminClient();
  const loaded = await loadJobSheet(admin, id);
  if (!loaded) notFound();
  const { data: d, apptType, surveyId } = loaded;
  const [photos, { data: completion }, { data: myStaff }] = await Promise.all([
    surveyId ? loadPhotoSignedUrls(admin, surveyId) : Promise.resolve([]),
    admin
      .from("job_completions")
      .select("customer_name, customer_absent, crew_name, exceptions, signed_at, certificate_emailed_at")
      .eq("appointment_id", id)
      .maybeSingle(),
    admin.from("staff").select("full_name").eq("profile_id", profile.id).eq("is_active", true).maybeSingle(),
  ]);
  const isRemoval = apptType === "removal";
  const fromLine = [d.from.address, d.from.postcode].filter(Boolean).join(", ");
  const toLine = [d.to.address, d.to.postcode].filter(Boolean).join(", ");

  const eyebrow = (icon: React.ReactNode, text: string) => (
    <p className="eyebrow flex items-center gap-1.5">
      {icon}
      {text}
    </p>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-16 items-center justify-between border-b bg-card px-5">
        <span className="font-display text-xl text-foreground">
          Marley <span className="text-mm-red">Ops</span>
        </span>
        <SignOutButton />
      </header>

      <main className="mx-auto max-w-2xl p-5 md:p-8">
        <Link
          href="/my-jobs"
          className="focus-ring inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-mist-500 hover:text-foreground"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} />
          My jobs
        </Link>

        {/* headline */}
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">{isRemoval ? "Move" : apptType}{d.quoteRef ? ` · ${d.quoteRef}` : ""}</p>
            <h1 className="mt-1 font-display text-3xl font-bold text-foreground">{d.customerName}</h1>
            <p className="mt-1 text-sm text-mist-500">
              {fmtDate(d.moveDate)} · {d.timeWindow}
              {d.days > 1 ? ` · ${d.days}-day job` : ""}
            </p>
          </div>
          <span
            className={
              "mt-1 shrink-0 rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide " +
              (isRemoval ? "bg-mm-red-tint text-mm-red-deep" : "bg-muted text-mist-500")
            }
          >
            {isRemoval ? "Move" : "Survey"}
          </span>
        </div>

        {/* contract flag — never gates the move, but the crew can't miss it */}
        {isRemoval && !completion && d.contractSigned === false ? (
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
        ) : null}

        {/* actions */}
        <div className="mt-4 flex flex-wrap gap-2">
          {isRemoval && !completion ? (
            <CompleteJobButton
              job={{
                appointmentId: id,
                customerName: d.customerName,
                quoteRef: d.quoteRef,
                moveDate: d.moveDate,
                fromLine,
                toLine,
                crewNameDefault: myStaff?.full_name ?? profile.full_name ?? "",
              }}
            />
          ) : null}
          {isRemoval ? <JobSheetButton appointmentId={id} fileHint={d.customerName} /> : null}
          {d.customerPhone ? (
            <a
              href={`tel:${d.customerPhone.replace(/\s+/g, "")}`}
              className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Phone className="size-4" strokeWidth={1.75} />
              Call {d.customerName.split(" ")[0]}
            </a>
          ) : null}
        </div>

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
                <p className="mt-1.5 text-sm font-medium text-foreground">{side.address || "—"}</p>
                {side.postcode ? <p className="tabular text-sm font-semibold text-foreground">{side.postcode}</p> : null}
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
                <li className="text-mist-400">No vehicles assigned yet — check the board.</li>
              )}
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            {eyebrow(<UserRound className="size-3.5" strokeWidth={1.75} />, "Crew")}
            <ul className="mt-1.5 space-y-1 text-sm text-foreground">
              {d.crew.length ? (
                d.crew.map((c) => <li key={c}>{c}</li>)
              ) : (
                <li className="text-mist-400">No crew assigned yet — check the board.</li>
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

        {/* notes */}
        {d.accessNotes || d.largeItemsNotes || d.jobNotes ? (
          <div className="mt-3 rounded-lg border border-border bg-card p-4">
            {eyebrow(<StickyNote className="size-3.5" strokeWidth={1.75} />, "Notes")}
            <div className="mt-1.5 space-y-1.5 text-sm text-foreground">
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

        <div className="mt-4 flex items-center gap-1.5 text-xs text-mist-400">
          <CalendarDays className="size-3.5" strokeWidth={1.75} />
          If anything on this job looks wrong, call the office before setting off.
        </div>
      </main>
    </div>
  );
}
