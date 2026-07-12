import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  CalendarCheck,
  CalendarPlus,
  FilePlus2,
  MapPin,
  Phone,
  ScanLine,
  UserPlus,
} from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { startOfUkDay } from "@/lib/uk-time";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { IconBadge } from "@/components/ui/icon-badge";
import { LeadStatusBadge } from "@/components/lead-status-badge";

export const dynamic = "force-dynamic";

const UK = "Europe/London";

function timeLabel(value: string | null): string {
  if (!value) return "Time TBC";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: UK,
  });
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: UK,
  });
}

export default async function EstimatorWorkspacePage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "estimator") redirect("/");

  const sb = await createClient();
  const today = startOfUkDay();
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  const [{ data: appointments }, { data: assignedLeads }] = await Promise.all([
    sb
      .from("appointments")
      .select("id, starts_at, ends_at, status, location, lead_id")
      .eq("appt_type", "survey")
      .eq("estimator_id", profile.id)
      .neq("status", "cancelled")
      .gte("starts_at", today.toISOString())
      .lt("starts_at", nextWeek.toISOString())
      .order("starts_at", { ascending: true }),
    sb
      .from("leads")
      .select("id, name, phone, email, status, from_postcode, to_postcode, first_contacted_at, estimator_id")
      .eq("estimator_id", profile.id)
      .in("status", ["website_enquiry", "survey_booked", "quoted", "provisional"])
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  const appointmentLeadIds = [...new Set((appointments ?? []).map((a) => a.lead_id).filter(Boolean))] as string[];
  const assignedIds = new Set((assignedLeads ?? []).map((lead) => lead.id));
  const missingIds = appointmentLeadIds.filter((id) => !assignedIds.has(id));
  const { data: appointmentLeads } = missingIds.length
    ? await sb
        .from("leads")
        .select("id, name, phone, email, status, from_postcode, to_postcode, first_contacted_at, estimator_id")
        .in("id", missingIds)
    : { data: [] };

  const leadById = new Map(
    [...(assignedLeads ?? []), ...(appointmentLeads ?? [])].map((lead) => [lead.id, lead]),
  );
  const todayEnd = new Date(today);
  todayEnd.setDate(todayEnd.getDate() + 1);
  const todaysAppointments = (appointments ?? []).filter(
    (appointment) => appointment.starts_at && new Date(appointment.starts_at) < todayEnd,
  );
  const firstName = (profile.full_name || profile.email || "there").split(/\s+/)[0];

  const starts = [
    { href: "/leads/new", label: "New lead", detail: "Capture an enquiry", icon: UserPlus, tone: "red" as const },
    { href: "/schedule/surveys?new=1", label: "Book survey", detail: "Choose a customer and time", icon: CalendarPlus, tone: "teal" as const },
    { href: "/quotes/new", label: "New quote", detail: "Start from customer details", icon: FilePlus2, tone: "blue" as const },
  ];

  return (
    <main className="page-shell">
      <PageHeader eyebrow="Estimator workspace" title={`My day, ${firstName}`} />

      <section aria-labelledby="start-workflow">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="start-workflow" className="text-sm font-semibold text-foreground">Start a workflow</h2>
          <span className="text-xs text-mist-400">One tap to begin</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {starts.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              className="focus-ring group flex min-h-24 items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(15,23,42,0.035)] transition-[border-color,transform] hover:-translate-y-0.5 hover:border-mist-300"
            >
              <IconBadge icon={item.icon} tone={item.tone} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{item.label}</span>
                <span className="mt-0.5 block text-xs text-mist-400">{item.detail}</span>
              </span>
              <ArrowRight className="size-4 text-mist-300 transition-transform group-hover:translate-x-0.5" strokeWidth={1.65} />
            </Link>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <section aria-labelledby="surveys-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Today</p>
              <h2 id="surveys-heading" className="font-display text-2xl font-semibold text-foreground">Your surveys</h2>
            </div>
            <Link href="/schedule/surveys" className="focus-ring rounded-md text-sm font-medium text-mm-red hover:underline">
              Full diary
            </Link>
          </div>

          {todaysAppointments.length === 0 ? (
            <Card className="p-6 text-center">
              <CalendarCheck className="mx-auto size-7 text-mist-300" strokeWidth={1.5} />
              <p className="mt-2 text-sm font-medium text-foreground">No surveys booked today</p>
              <p className="mt-1 text-xs text-mist-400">Use the time to clear assigned leads or book the next visit.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {todaysAppointments.map((appointment, index) => {
                const lead = appointment.lead_id ? leadById.get(appointment.lead_id) : null;
                const leadId = appointment.lead_id;
                return (
                  <Card key={appointment.id} className="overflow-hidden p-0">
                    <div className="grid sm:grid-cols-[112px_minmax(0,1fr)]">
                      <div className="border-b border-border bg-[#10161d] px-4 py-4 text-white sm:border-b-0 sm:border-r sm:py-5">
                        <p className="text-xs font-medium text-white/45">Survey {index + 1}</p>
                        <p className="mt-1 font-display text-2xl font-semibold tabular">{timeLabel(appointment.starts_at)}</p>
                      </div>
                      <div className="p-4 sm:p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-lg font-semibold text-foreground">{lead?.name ?? "Customer"}</p>
                            <p className="mt-1 flex items-center gap-1.5 text-sm text-mist-500">
                              <MapPin className="size-4 shrink-0" strokeWidth={1.65} />
                              {appointment.location || [lead?.from_postcode, lead?.to_postcode].filter(Boolean).join(" to ") || "Address TBC"}
                            </p>
                          </div>
                          <span className="rounded-full bg-survey-bg px-2.5 py-1 text-xs font-semibold text-survey">
                            {dateLabel(appointment.starts_at)}
                          </span>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {lead?.phone ? (
                            <a href={`tel:${lead.phone.replace(/\s+/g, "")}`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">
                              <Phone className="size-4" strokeWidth={1.65} /> Call
                            </a>
                          ) : null}
                          {leadId ? (
                            <>
                              <Link href={`/leads/${leadId}`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">
                                Open lead
                              </Link>
                              <Link href={`/leads/${leadId}/cubic`} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep">
                                <ScanLine className="size-4" strokeWidth={1.65} /> Start survey
                              </Link>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="attention-heading">
          <div className="mb-3">
            <p className="eyebrow">Assigned to you</p>
            <h2 id="attention-heading" className="font-display text-2xl font-semibold text-foreground">Needs attention</h2>
          </div>
          <Card className="p-0">
            {(assignedLeads ?? []).length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-mist-400">No active leads assigned.</p>
            ) : (
              <ul className="divide-y">
                {(assignedLeads ?? []).slice(0, 8).map((lead) => (
                  <li key={lead.id}>
                    <Link href={`/leads/${lead.id}`} className="focus-ring flex min-h-20 items-center justify-between gap-3 px-4 py-3.5 hover:bg-muted/70">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">{lead.name ?? "Unnamed lead"}</span>
                        <span className="mt-1 block text-xs text-mist-400">
                          {[lead.from_postcode, lead.to_postcode].filter(Boolean).join(" to ") || "Route not captured"}
                        </span>
                      </span>
                      <LeadStatusBadge status={lead.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/leads" className="focus-ring flex min-h-12 items-center justify-center border-t text-sm font-semibold text-mm-red hover:bg-mm-red-tint/40">
              View all leads
            </Link>
          </Card>
        </section>
      </div>
    </main>
  );
}
