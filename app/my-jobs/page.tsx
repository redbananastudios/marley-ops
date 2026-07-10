import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, MapPin, Phone, Truck, UserRound } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { apptWindow } from "@/lib/job-board";
import { JobSheetButton } from "@/components/job-sheet-button";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";

/**
 * /my-jobs — the crew surface (iMVE "can access assigned jobs"). A crew login
 * lands here (the dashboard redirects them) and sees ONLY the jobs they're
 * assigned to, with the job-sheet PDF one tap away. Phone-first layout: this
 * page gets read in a van cab.
 */

export const dynamic = "force-dynamic";

const UK = "Europe/London";

function dayHeading(day: string, today: string): string {
  if (day === today) return "Today";
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export default async function MyJobsPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  const sb = await createClient();

  // Link login → crew record: explicit profile_id first, then email match.
  let { data: staffRow } = await sb
    .from("staff")
    .select("id, full_name")
    .eq("profile_id", profile.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staffRow && profile.email) {
    const { data: byEmail } = await sb
      .from("staff")
      .select("id, full_name")
      .ilike("email", profile.email)
      .eq("is_active", true)
      .maybeSingle();
    staffRow = byEmail ?? null;
    // Persist the discovered link so the next visit is a single lookup.
    if (byEmail) await sb.from("staff").update({ profile_id: profile.id }).eq("id", byEmail.id);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });

  type Job = {
    id: string;
    title: string | null;
    starts_at: string | null;
    ends_at: string | null;
    all_day: boolean | null;
    appt_type: string;
    location: string | null;
    lead_name: string | null;
    lead_phone: string | null;
    from_postcode: string | null;
    to_postcode: string | null;
    crewMates: string[];
    vans: string[];
  };

  let jobs: Job[] = [];
  if (staffRow) {
    const { data: myAssigns } = await sb
      .from("appointment_assignments")
      .select("appointment_id")
      .eq("staff_id", staffRow.id);
    const apptIds = [...new Set((myAssigns ?? []).map((a) => a.appointment_id))];

    if (apptIds.length) {
      const [{ data: appts }, { data: allAssigns }] = await Promise.all([
        sb
          .from("appointments")
          .select("id, title, starts_at, ends_at, all_day, appt_type, status, location, lead_id")
          .in("id", apptIds)
          .neq("status", "cancelled")
          .order("starts_at"),
        sb.from("appointment_assignments").select("appointment_id, staff_id, vehicle_id").in("appointment_id", apptIds),
      ]);

      const leadIds = [...new Set((appts ?? []).map((a) => a.lead_id).filter(Boolean))] as string[];
      const mateIds = [...new Set((allAssigns ?? []).map((a) => a.staff_id).filter(Boolean))] as string[];
      const vanIds = [...new Set((allAssigns ?? []).map((a) => a.vehicle_id).filter(Boolean))] as string[];
      const [{ data: leads }, { data: mates }, { data: vans }] = await Promise.all([
        leadIds.length
          ? sb.from("leads").select("id, name, phone, from_postcode, to_postcode").in("id", leadIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null; phone: string | null; from_postcode: string | null; to_postcode: string | null }[] }),
        mateIds.length
          ? sb.from("staff").select("id, full_name").in("id", mateIds)
          : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
        vanIds.length
          ? sb.from("vehicles").select("id, name").in("id", vanIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);
      const leadById = new Map((leads ?? []).map((l) => [l.id, l]));
      const mateName = new Map((mates ?? []).map((m) => [m.id, m.full_name]));
      const vanName = new Map((vans ?? []).map((v) => [v.id, v.name]));

      // Show from yesterday onwards — a late-running job stays visible next morning.
      const cutoff = new Date(`${today}T00:00:00Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);

      jobs = (appts ?? [])
        .filter((a) => a.starts_at && new Date(a.starts_at).getTime() >= cutoff.getTime())
        .map((a) => {
          const lead = a.lead_id ? leadById.get(a.lead_id) : null;
          const its = (allAssigns ?? []).filter((x) => x.appointment_id === a.id);
          return {
            id: a.id,
            title: a.title,
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            all_day: a.all_day,
            appt_type: a.appt_type,
            location: a.location,
            lead_name: lead?.name ?? null,
            lead_phone: lead?.phone ?? null,
            from_postcode: lead?.from_postcode ?? null,
            to_postcode: lead?.to_postcode ?? null,
            crewMates: its
              .map((x) => (x.staff_id && x.staff_id !== staffRow!.id ? mateName.get(x.staff_id) : null))
              .filter(Boolean) as string[],
            vans: its.map((x) => (x.vehicle_id ? vanName.get(x.vehicle_id) : null)).filter(Boolean) as string[],
          };
        });
    }
  }

  // Group by UK day of the start.
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    const day = j.starts_at ? new Date(j.starts_at).toLocaleDateString("en-CA", { timeZone: UK }) : "unknown";
    const list = groups.get(day) ?? [];
    list.push(j);
    groups.set(day, list);
  }
  const orderedDays = [...groups.keys()].sort();

  // Week-at-a-glance: the next 7 days with how many jobs sit on each.
  const weekStrip = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    return {
      iso,
      dow: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
      date: d.getUTCDate(),
      count: groups.get(iso)?.length ?? 0,
      isToday: iso === today,
    };
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-16 items-center justify-between border-b bg-card px-5">
        <span className="font-display text-xl text-foreground">
          Marley <span className="text-mm-red">Ops</span>
        </span>
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-mist-500 sm:block">{staffRow?.full_name ?? profile.full_name}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-5 md:p-8">
        <p className="eyebrow">Your jobs</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">My jobs</h1>

        {staffRow ? (
          <div className="mt-4 grid grid-cols-7 gap-1.5" aria-label="Your week at a glance">
            {weekStrip.map((d) => (
              <div
                key={d.iso}
                className={
                  "flex flex-col items-center rounded-lg border py-2 " +
                  (d.isToday ? "border-mm-red bg-mm-red-tint/50" : "border-border bg-card")
                }
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide text-mist-400">{d.dow}</span>
                <span className={"text-sm font-semibold " + (d.isToday ? "text-mm-red-deep" : "text-foreground")}>
                  {d.date}
                </span>
                <span
                  className={
                    "mt-1 flex size-5 items-center justify-center rounded-full text-[11px] font-bold " +
                    (d.count > 0 ? "bg-mm-red text-white" : "bg-muted text-mist-300")
                  }
                  aria-label={`${d.count} job${d.count === 1 ? "" : "s"}`}
                >
                  {d.count > 0 ? d.count : "·"}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {!staffRow ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            This login isn&apos;t linked to a crew record yet — ask the office to add you under Staff &amp; Fleet with
            this email address.
          </div>
        ) : orderedDays.length === 0 ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            Nothing assigned to you yet. When the office puts you on a job it shows up here.
          </div>
        ) : (
          orderedDays.map((day) => (
            <section key={day} className="mt-6">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-mist-400">
                {dayHeading(day, today)}
              </h2>
              <div className="space-y-3">
                {groups.get(day)!.map((j) => (
                  <div key={j.id} className="rounded-lg border border-border bg-card p-4">
                    {/* Card body opens the full job page; buttons below stay their own targets. */}
                    <Link href={`/my-jobs/${j.id}`} className="focus-ring -m-2 block rounded-md p-2 active:bg-muted">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-foreground">{j.lead_name ?? j.title ?? "Job"}</p>
                          <p className="mt-0.5 text-sm text-mist-500">
                            {apptWindow(j)} · <span className="capitalize">{j.appt_type === "removal" ? "Move" : j.appt_type}</span>
                          </p>
                        </div>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span
                            className={
                              "rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide " +
                              (j.appt_type === "removal" ? "bg-mm-red-tint text-mm-red-deep" : "bg-muted text-mist-500")
                            }
                          >
                            {j.appt_type === "removal" ? "Move" : "Survey"}
                          </span>
                          <ChevronRight className="size-4 text-mist-400" strokeWidth={1.75} />
                        </span>
                      </div>

                      <div className="mt-2 space-y-1 text-sm text-mist-500">
                        {j.from_postcode || j.to_postcode ? (
                          <p className="tabular flex items-center gap-2">
                            <MapPin className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                            {j.from_postcode ?? "?"} → {j.to_postcode ?? "?"}
                          </p>
                        ) : j.location ? (
                          <p className="flex items-center gap-2">
                            <MapPin className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                            {j.location}
                          </p>
                        ) : null}
                        {j.crewMates.length ? (
                          <p className="flex items-center gap-2">
                            <UserRound className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                            With {j.crewMates.join(", ")}
                          </p>
                        ) : null}
                        {j.vans.length ? (
                          <p className="flex items-center gap-2">
                            <Truck className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                            {j.vans.join(", ")}
                          </p>
                        ) : null}
                      </div>
                    </Link>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {j.appt_type === "removal" ? (
                        <JobSheetButton appointmentId={j.id} fileHint={j.lead_name ?? j.title ?? "job"} />
                      ) : null}
                      {j.lead_phone ? (
                        <a
                          href={`tel:${j.lead_phone.replace(/\s+/g, "")}`}
                          className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
                        >
                          <Phone className="size-4" strokeWidth={1.75} />
                          Call customer
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
