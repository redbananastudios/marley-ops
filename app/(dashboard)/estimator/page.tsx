import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  BellRing,
  CalendarCheck,
  CalendarPlus,
  FilePlus2,
  FileText,
  MapPin,
  Phone,
  ScanLine,
  UserPlus,
} from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isOwnedByEstimator } from "@/lib/leads/ownership";
import { startOfUkDay } from "@/lib/uk-time";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { IconBadge } from "@/components/ui/icon-badge";
import { LeadStatusBadge } from "@/components/lead-status-badge";

export const dynamic = "force-dynamic";

const UK = "Europe/London";
const ACTIVE_STATUSES = ["website_enquiry", "survey_booked", "quoted", "provisional"] as const;
const ACTIVE_SET = new Set<string>(ACTIVE_STATUSES);
const LEAD_COLS =
  "id, name, phone, email, status, from_postcode, to_postcode, first_contacted_at, submitted_at, created_at, estimator_id";

interface ELead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  from_postcode: string | null;
  to_postcode: string | null;
  first_contacted_at: string | null;
  submitted_at: string | null;
  created_at: string | null;
  estimator_id: string | null;
}

const FOLLOWUP_REASON_LABEL: Record<string, string> = {
  no_answer: "No answer — retry",
  quote_followup: "Quote follow-up",
  deposit: "Deposit chase",
  balance: "Balance chase",
  custom: "Follow-up",
};

function timeLabel(value: string | null): string {
  if (!value) return "Time TBC";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: UK,
  });
}

function dateLabel(value: string | null): string {
  if (!value) return "Date TBC";
  return new Date(value).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: UK,
  });
}

/** "3d ago" / "5h ago" / "just now" — for how long a quote has sat unanswered. */
function daysAgo(value: string | null): string {
  if (!value) return "recently";
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hrs = Math.floor(ms / 3_600_000);
  return hrs >= 1 ? `${hrs}h ago` : "just now";
}

/** Newest-signal instant for a lead — mirrors the leads board's tsOf(). */
function leadTs(l: ELead): number {
  return new Date(l.submitted_at || l.created_at || 0).getTime();
}

/** Request-time "now" via a helper so the render body stays free of a bare, impure
 *  Date.now() (react-compiler flags that; a server component re-renders per request
 *  so the value is fine — same reason daysAgo() reads the clock inside a function). */
function nowMs(): number {
  return Date.now();
}

export default async function EstimatorWorkspacePage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "estimator") redirect("/");

  const sb = await createClient();
  const me = profile.id;
  const today = startOfUkDay();
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  // Batch 1 — the day's survey diary, every lead I own a survey on (for ownership),
  // and every lead explicitly assigned to me. All independent, so fired together.
  const [{ data: appointments }, { data: mySurveyRows }, { data: explicitLeads }] = await Promise.all([
    sb
      .from("appointments")
      .select("id, starts_at, ends_at, status, location, lead_id")
      .eq("appt_type", "survey")
      .eq("estimator_id", me)
      .neq("status", "cancelled")
      .gte("starts_at", today.toISOString())
      .lt("starts_at", nextWeek.toISOString())
      .order("starts_at", { ascending: true }),
    sb
      .from("appointments")
      .select("lead_id")
      .eq("appt_type", "survey")
      .eq("estimator_id", me)
      .neq("status", "cancelled"),
    sb.from("leads").select(LEAD_COLS).eq("estimator_id", me).in("status", [...ACTIVE_STATUSES]),
  ]);

  const mySurveyLeadIds = [...new Set((mySurveyRows ?? []).map((r) => r.lead_id).filter(Boolean))] as string[];
  const mySurveySet = new Set(mySurveyLeadIds);

  // Batch 2 — the full record (any status) of every lead behind one of my surveys,
  // so survey cards and survey-derived ownership can resolve even for booked/done jobs.
  const { data: surveyLeads } = mySurveyLeadIds.length
    ? await sb.from("leads").select(LEAD_COLS).in("id", mySurveyLeadIds)
    : { data: [] as ELead[] };

  const leadById = new Map<string, ELead>();
  for (const l of [...((explicitLeads ?? []) as ELead[]), ...((surveyLeads ?? []) as ELead[])]) {
    leadById.set(l.id, l);
  }

  // Unified ownership: estimator_id (explicit) OR survey-derived — the same rule the
  // /leads "Mine" preset uses, so a lead can't show here and vanish there.
  const ownedFor = (l: ELead): boolean =>
    isOwnedByEstimator(me, l.estimator_id, mySurveySet.has(l.id) ? me : null);
  const myLeadIds = [...leadById.values()].filter(ownedFor).map((l) => l.id);

  // Batch 3 — my open follow-ups (mine OR on one of my leads) + quotes still awaiting
  // a customer reply on my leads. Both keyed off the lead set, no per-row queries.
  const followUpsBuilder = sb
    .from("follow_ups")
    .select("id, lead_id, reason, due_at, assigned_to")
    .eq("status", "open");
  const [{ data: followUps }, { data: sentQuotes }] = await Promise.all([
    myLeadIds.length
      ? followUpsBuilder.or(`assigned_to.eq.${me},lead_id.in.(${myLeadIds.join(",")})`).order("due_at", { ascending: true })
      : followUpsBuilder.eq("assigned_to", me).order("due_at", { ascending: true }),
    myLeadIds.length
      ? sb
          .from("quotes")
          .select("id, lead_id, quote_ref, status, email_sent_at, updated_at, created_at")
          .eq("status", "sent")
          .in("lead_id", myLeadIds)
          .order("email_sent_at", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] as { id: string; lead_id: string | null; quote_ref: string; status: string; email_sent_at: string | null; updated_at: string; created_at: string }[] }),
  ]);

  // Batch 4 — names for any follow-up lead I don't already hold (a chase assigned to
  // me on someone else's lead). One batched fetch, only when there's a gap.
  const missingIds = [
    ...new Set(
      [...(followUps ?? []).map((f) => f.lead_id), ...(sentQuotes ?? []).map((q) => q.lead_id)].filter(
        (id): id is string => !!id && !leadById.has(id),
      ),
    ),
  ];
  if (missingIds.length) {
    const { data: extra } = await sb.from("leads").select(LEAD_COLS).in("id", missingIds);
    for (const l of (extra ?? []) as ELead[]) leadById.set(l.id, l);
  }

  // Today's surveys vs the rest of the week (the page used to discard the remainder).
  const todayEnd = new Date(today);
  todayEnd.setDate(todayEnd.getDate() + 1);
  const allAppointments = (appointments ?? []).filter((a) => a.starts_at);
  const todaysAppointments = allAppointments.filter((a) => new Date(a.starts_at as string) < todayEnd);
  const laterAppointments = allAppointments.filter((a) => new Date(a.starts_at as string) >= todayEnd);

  // Needs attention: active leads I own, ordered like the leads board — uncontacted
  // first, longest-waiting on top (rank asc, then oldest first).
  const ownedActive = [...leadById.values()]
    .filter((l) => ACTIVE_SET.has(l.status) && ownedFor(l))
    .sort((a, b) => {
      const ra = a.first_contacted_at ? 1 : 0;
      const rb = b.first_contacted_at ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return leadTs(a) - leadTs(b);
    });

  const now = nowMs();
  const overdueCount = (followUps ?? []).filter((f) => new Date(f.due_at).getTime() < now).length;

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

          {laterAppointments.length > 0 ? (
            <div className="mt-5">
              <p className="eyebrow mb-2">Later this week</p>
              <Card className="p-0">
                <ul className="divide-y">
                  {laterAppointments.map((appointment) => {
                    const lead = appointment.lead_id ? leadById.get(appointment.lead_id) : null;
                    const postcode =
                      [lead?.from_postcode, lead?.to_postcode].filter(Boolean).join(" → ") ||
                      appointment.location ||
                      "Address TBC";
                    const row = (
                      <span className="flex min-h-14 items-center gap-3 px-4 py-2.5">
                        <span className="w-14 shrink-0 text-center">
                          <span className="block text-xs font-semibold text-survey">{dateLabel(appointment.starts_at)}</span>
                          <span className="tabular block text-xs text-mist-400">{timeLabel(appointment.starts_at)}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{lead?.name ?? "Customer"}</span>
                          <span className="block truncate text-xs text-mist-400">{postcode}</span>
                        </span>
                      </span>
                    );
                    return (
                      <li key={appointment.id}>
                        {appointment.lead_id ? (
                          <Link href={`/leads/${appointment.lead_id}`} className="focus-ring block hover:bg-muted/70">
                            {row}
                          </Link>
                        ) : (
                          row
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          ) : null}
        </section>

        <div className="space-y-6">
          <section aria-labelledby="followups-heading">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div className="flex items-center gap-2">
                <div>
                  <p className="eyebrow">Due</p>
                  <h2 id="followups-heading" className="font-display text-2xl font-semibold text-foreground">Follow-ups due</h2>
                </div>
                {overdueCount > 0 ? (
                  <span className="rounded-full bg-danger-bg px-2 py-0.5 text-xs font-semibold text-danger">
                    {overdueCount} overdue
                  </span>
                ) : null}
              </div>
              <Link href="/follow-ups" className="focus-ring rounded-md text-sm font-medium text-mm-red hover:underline">
                All follow-ups
              </Link>
            </div>
            <Card className="p-0">
              {(followUps ?? []).length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <BellRing className="mx-auto size-6 text-mist-300" strokeWidth={1.5} />
                  <p className="mt-2 text-sm text-mist-400">Nothing due — you&apos;re on top of it.</p>
                </div>
              ) : (
                <ul className="divide-y">
                  {(followUps ?? []).slice(0, 6).map((fu) => {
                    const lead = fu.lead_id ? leadById.get(fu.lead_id) : null;
                    const overdue = new Date(fu.due_at).getTime() < now;
                    return (
                      <li key={fu.id}>
                        <Link
                          href={fu.lead_id ? `/leads/${fu.lead_id}` : "/follow-ups"}
                          className="focus-ring flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-muted/70"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-foreground">{lead?.name ?? "Lead"}</span>
                            <span className="mt-0.5 block text-xs text-mist-400">
                              {FOLLOWUP_REASON_LABEL[fu.reason] ?? "Follow-up"}
                            </span>
                          </span>
                          <span
                            className={
                              overdue
                                ? "shrink-0 text-xs font-semibold text-danger"
                                : "shrink-0 text-xs font-medium text-mist-400"
                            }
                          >
                            {overdue ? "Overdue" : "Due"} {dateLabel(fu.due_at)}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section aria-labelledby="quotes-heading">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="eyebrow">Sent</p>
                <h2 id="quotes-heading" className="font-display text-2xl font-semibold text-foreground">Quotes awaiting reply</h2>
              </div>
              <Link href="/quotes" className="focus-ring rounded-md text-sm font-medium text-mm-red hover:underline">
                All quotes
              </Link>
            </div>
            <Card className="p-0">
              {(sentQuotes ?? []).length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <FileText className="mx-auto size-6 text-mist-300" strokeWidth={1.5} />
                  <p className="mt-2 text-sm text-mist-400">No quotes waiting on a reply.</p>
                </div>
              ) : (
                <>
                  <ul className="divide-y">
                    {(sentQuotes ?? []).slice(0, 6).map((q) => {
                      const lead = q.lead_id ? leadById.get(q.lead_id) : null;
                      return (
                        <li key={q.id}>
                          <Link
                            href={`/quotes/${q.id}`}
                            className="focus-ring flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-muted/70"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-foreground">{lead?.name ?? "Customer"}</span>
                              <span className="mt-0.5 block truncate text-xs text-mist-400">{q.quote_ref}</span>
                            </span>
                            <span className="shrink-0 text-xs font-medium text-mist-400">
                              sent {daysAgo(q.email_sent_at ?? q.updated_at ?? q.created_at)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="border-t border-border px-4 py-2.5 text-xs text-mist-400">
                    Marley chases unanswered quotes by email automatically.
                  </p>
                </>
              )}
            </Card>
          </section>

          <section aria-labelledby="attention-heading">
            <div className="mb-3">
              <p className="eyebrow">Assigned to you</p>
              <h2 id="attention-heading" className="font-display text-2xl font-semibold text-foreground">Needs attention</h2>
            </div>
            <Card className="p-0">
              {ownedActive.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-mist-400">No active leads assigned.</p>
              ) : (
                <ul className="divide-y">
                  {ownedActive.slice(0, 8).map((lead) => (
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
      </div>
    </main>
  );
}
