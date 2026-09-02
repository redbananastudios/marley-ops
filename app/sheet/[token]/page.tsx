import type { Metadata } from "next";
import { GROUP_PAGE_THEME as theme } from "@/lib/brand-page-theme";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleDaySheets, type CrewDaySheet, type DailyJob } from "@/lib/crew-sheet/daily-data";
import { loadPhotoSignedUrls, type WebPhoto } from "@/lib/job-sheet-load";
import { UK_TZ } from "@/lib/uk-time";

/**
 * /sheet/<token> — the crew member's day sheet on the web, opened straight from
 * the SMS with no login (the /q, /s, /cv pattern: the unguessable token IS the
 * credential; noindex). Deliberately reads LIVE data every time — the same
 * assembly the emailed PDF used — so a crew member on a patchy signal always
 * sees the current plan, not a stale copy. Price-free, like every crew surface.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  // GROUP surface (PRD §4): a crew day legitimately spans brands, so the sheet
  // itself is neutral and each JOB block carries its own brand chip. Naming a
  // brand in the title would be wrong on any mixed day.
  title: "Your day sheet",
  robots: { index: false, follow: false },
};

// PII on an unauthenticated page: stop serving a token once its work-date is
// well past, so an old link can't resurrect a customer's address indefinitely.
const STALE_DAYS = 3;

const fmtLong = (d: string): string =>
  new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const nowLabel = (): string =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ });

/** Request-time "now" via a helper so the render body stays free of a bare,
 *  impure Date.now() (react-compiler flags that; a server component re-renders
 *  per request so a per-request clock read is correct). */
const nowMs = (): number => Date.now();

const kindLabel = (t: string): string => (t === "removal" ? "Move" : t === "survey" ? "Survey" : t);

function AddressBlock({ title, a }: { title: string; a: DailyJob["sheet"]["from"] }) {
  const access = [
    a.propertyType || null,
    a.floor && a.floor !== "ground" ? `floor: ${a.floor}` : a.propertyType ? "ground floor" : null,
    a.lift === "yes" ? "lift" : null,
    a.accessM > 0 ? `carry ~${a.accessM}m` : null,
  ].filter(Boolean);
  return (
    <div className="flex-1">
      <p className="text-[11px] font-bold uppercase tracking-wide text-mm-red">{title}</p>
      <p className="mt-0.5 text-sm font-semibold text-ink">{a.address || "—"}</p>
      {a.postcode ? <p className="text-sm font-bold text-mm-red">{a.postcode}</p> : null}
      {access.length ? <p className="mt-0.5 text-xs text-mist-500">{access.join(" · ")}</p> : null}
    </div>
  );
}

function DetailRow({ label, lines }: { label: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="mt-2 flex gap-3">
      <p className="w-20 shrink-0 text-[11px] font-bold uppercase tracking-wide text-mm-red">{label}</p>
      <div className="min-w-0 flex-1 space-y-0.5">
        {lines.map((l, i) => (
          <p key={i} className="break-words text-sm text-ink">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

/** The two dead ends this page can serve — an expired link, and a day we could
 *  not load. Both keep the crew member's next move on screen (the office
 *  number, on a page that looks like ours) rather than the generic error shell,
 *  whose only offered action is a dashboard they cannot sign in to. */
function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main
      className="mx-auto min-h-screen max-w-xl bg-mist-50 px-5 py-10"
      style={theme.rootStyle as React.CSSProperties | undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={theme.logoUrl ?? "/logo.png"} alt={theme.name} width={160} className="mx-auto mb-6" />
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="font-brand text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-3 text-sm text-mist-500">{children}</p>
      </div>
    </main>
  );
}

function JobCard({
  job,
  index,
  total,
  photos,
  brandMark,
}: {
  job: DailyJob;
  index: number;
  total: number;
  photos: WebPhoto[];
  /** The job's brand short name, or null on a single-brand day. Which company
   *  name to give at the door is the one thing a crew member cannot work out
   *  from the rest of the card. */
  brandMark: string | null;
}) {
  const s = job.sheet;
  const inventory = s.items.map((i) => `${i.label} × ${i.qty}`);
  const vehicles = s.vehicles.length ? s.vehicles : s.vehicleLabel ? [`Required: ${s.vehicleLabel}`] : [];
  const notes = [
    s.accessNotes ? `Access: ${s.accessNotes}` : null,
    s.largeItemsNotes ? `Large items: ${s.largeItemsNotes}` : null,
    s.jobNotes || null,
  ].filter(Boolean) as string[];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between bg-charcoal px-4 py-2.5">
        <p className="text-base font-bold text-white">
          {job.window} <span className="text-sm font-normal text-mist-200">{kindLabel(job.apptType)}</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Neutral fill, not the brand's colour: this is a GROUP surface
              (PRD §4) and the shell's accent is charcoal for either brand. */}
          {brandMark ? (
            <span className="rounded-sm bg-white/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
              {brandMark}
            </span>
          ) : null}
          <p className="text-xs text-mist-300">
            Job {index + 1} of {total}
          </p>
        </div>
      </div>
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-lg font-bold text-ink">{s.customerName || "Customer"}</p>
          {s.customerPhone ? (
            <a href={`tel:${s.customerPhone.replace(/\s+/g, "")}`} className="shrink-0 text-base font-bold text-mm-red">
              {s.customerPhone}
            </a>
          ) : (
            <span className="shrink-0 text-xs text-mist-400">no phone on file</span>
          )}
        </div>
        {s.quoteRef ? <p className="mt-0.5 text-xs text-mist-400">{s.quoteRef}</p> : null}
        {s.contractSigned === false ? (
          <p className="mt-2 rounded-md border-l-4 border-mm-red bg-mm-red-tint/50 px-3 py-2 text-sm font-semibold text-mm-red">
            Contract not yet signed — collect the customer&apos;s signature on arrival.
          </p>
        ) : null}

        <div className="mt-3 flex gap-4">
          <AddressBlock title="Moving from" a={s.from} />
          <AddressBlock title="Moving to" a={s.to} />
        </div>

        <DetailRow label="Vehicle" lines={vehicles} />
        <DetailRow label="Crew" lines={s.crew} />
        <DetailRow label="Packing" lines={s.packingLabel ? [s.packingLabel] : []} />
        <DetailRow label="Inventory" lines={inventory} />
        <DetailRow label="Notes" lines={notes} />

        {photos.length ? (
          <div className="mt-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-mm-red">Photos</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {photos.map((p, i) => (
                <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.caption || p.label} className="h-32 w-full rounded-md border border-border object-cover" />
                  <p className="mt-0.5 truncate text-xs text-mist-400">{p.caption ? `${p.label} — ${p.caption}` : p.label}</p>
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default async function CrewSheetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[\w-]{10,64}$/.test(token)) notFound();

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("crew_job_sheets")
    .select("id, staff_id, work_date, version")
    .eq("token", token)
    .maybeSingle();
  if (!row) notFound();

  // Stale link → stop leaking PII.
  const workMs = new Date(`${row.work_date}T00:00:00Z`).getTime();
  if (nowMs() - workMs > STALE_DAYS * 86_400_000) {
    return (
      <Notice title="This job sheet has expired">
        Links stay live for a few days around the job. For anything you still need, call the office on{" "}
        <a href={theme.telHref} className="font-semibold text-mm-red">
          {theme.phone}
        </a>
        .
      </Notice>
    );
  }

  const { data: staff } = await admin.from("staff").select("full_name").eq("id", row.staff_id).maybeSingle();
  const fullName = staff?.full_name ?? "Crew";
  const firstName = fullName.trim().split(/\s+/)[0] || fullName;

  // Live assembly — always the current plan.
  //
  // assembleDaySheets REFUSES a mixed-brand day whose brands read failed, so
  // markers are never silently absent. That refusal is written for the emailed
  // PDF, where a missing sheet is visible and the cron retries; here it would
  // hand a crew member the generic error page on move morning — no addresses,
  // no access notes, no customer phone — over a marker. Nothing retries on
  // their behalf, so retry once for them (the read it guards against fails
  // transiently: a PostgREST blip, a schema cache still warming after a
  // migration), then land on a branded call-the-office panel rather than let
  // the throw escape into the generic error shell.
  let all: CrewDaySheet[] | null = null;
  try {
    all = await assembleDaySheets(admin, row.work_date);
  } catch (err) {
    console.error("[crew-sheet] day assembly failed — retrying once for", row.work_date, err);
    all = await assembleDaySheets(admin, row.work_date).catch((again) => {
      console.error("[crew-sheet] day assembly failed twice — serving the call-the-office page:", again);
      return null;
    });
  }
  if (!all) {
    return (
      <Notice title={"We can't load your sheet right now"}>
        Something went wrong at our end — try again in a minute. If it&apos;s nearly time to set off, call
        the office on{" "}
        <a href={theme.telHref} className="font-semibold text-mm-red">
          {theme.phone}
        </a>{" "}
        and they&apos;ll read your jobs out.
      </Notice>
    );
  }

  const day: CrewDaySheet = all.find((d) => d.crew.id === row.staff_id) ?? {
    crew: { id: row.staff_id, fullName, email: null, phone: null },
    workDate: row.work_date,
    jobs: [],
  };
  const total = day.jobs.length;
  // The emailed PDF's gate, byte for byte (lib/crew-sheet/daily-docdef.ts), so
  // the two documents for one day can never disagree about which jobs are
  // marked: markers appear only when THIS crew member's day spans more than one
  // distinct brand, and a single-brand day renders exactly as it always has.
  const multiBrand = new Set(day.jobs.map((j) => j.brandShort ?? "")).size > 1;

  // Survey photos as short-lived signed URLs, per job (capped — a phone in a van).
  const photosByAppt: Record<string, WebPhoto[]> = {};
  await Promise.all(
    day.jobs.map(async (j) => {
      if (j.surveyId) photosByAppt[j.appointmentId] = await loadPhotoSignedUrls(admin, j.surveyId, 6).catch(() => []);
    }),
  );

  return (
    <main
      className="mx-auto min-h-screen max-w-xl bg-mist-50 px-4 py-8"
      style={theme.rootStyle as React.CSSProperties | undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={theme.logoUrl ?? "/logo.png"} alt={theme.name} width={150} className="mx-auto mb-5" />

      <div className="mb-4 rounded-lg bg-charcoal px-5 py-4 text-white">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-mist-300">Day sheet</p>
        <h1 className="mt-1 text-xl font-bold">{firstName}&apos;s jobs</h1>
        <p className="mt-0.5 text-sm text-mist-200">{fmtLong(row.work_date)}</p>
        <p className="mt-2 text-xs text-mist-400">
          {total === 0 ? "No jobs" : `${total} ${total === 1 ? "job" : "jobs"}`} · updated {nowLabel()}
        </p>
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-mist-500">
          You have no jobs booked for this day. If that&apos;s a surprise, call the office on{" "}
          <a href={theme.telHref} className="font-semibold text-mm-red">
            {theme.phone}
          </a>
          .
        </div>
      ) : (
        <div className="space-y-4">
          {day.jobs.map((job, i) => (
            <JobCard
              key={job.appointmentId}
              job={job}
              index={i}
              total={total}
              photos={photosByAppt[job.appointmentId] ?? []}
              brandMark={multiBrand ? job.brandShort ?? null : null}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-center text-xs text-mist-400">
        This link opens without signing in. Questions? Call{" "}
        <a href={theme.telHref} className="font-semibold">
          {theme.phone}
        </a>
      </p>
    </main>
  );
}
