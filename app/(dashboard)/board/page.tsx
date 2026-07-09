import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatusBoard, type BoardLead } from "@/components/board/status-board";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Unbounded tables page through fetchAllRows (PostgREST truncates at 1000 rows).
  const [leads, quoteData, apptData] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("leads")
        .select(
          "id, name, status, entry_channel, from_postcode, to_postcode, preferred_date, property_size, first_contacted_at, phone, estimator_id, submitted_at, created_at, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
        )
        .order("submitted_at", { ascending: false })
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("quotes").select("lead_id, grand_total, agreed_price, status, created_at").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("appointments").select("lead_id, appt_type, status, estimator_id").order("id").range(f, t),
    ),
  ]);

  /* estimator is survey-derived (assigned at survey booking), null before that */
  const surveyEstimator = new Map<string, string>();
  for (const a of apptData) {
    if (a.appt_type !== "survey" || a.status === "cancelled" || !a.lead_id || !a.estimator_id) continue;
    if (!surveyEstimator.has(a.lead_id)) surveyEstimator.set(a.lead_id, a.estimator_id);
  }

  /* per-lead best value: accepted agreed price, else latest quoted total */
  const valueMap = new Map<string, { accepted: number | null; latest: number | null; latestAt: number }>();
  for (const q of quoteData) {
    if (!q.lead_id) continue;
    const cur = valueMap.get(q.lead_id) ?? { accepted: null, latest: null, latestAt: 0 };
    if (q.status === "accepted") cur.accepted = Number(q.agreed_price ?? q.grand_total ?? 0);
    const at = new Date(q.created_at ?? 0).getTime();
    if (at >= cur.latestAt && q.grand_total != null) {
      cur.latest = Number(q.grand_total);
      cur.latestAt = at;
    }
    valueMap.set(q.lead_id, cur);
  }

  const cards: BoardLead[] = leads.map((l) => {
    const v = valueMap.get(l.id);
    return {
      id: l.id,
      name: l.name,
      status: l.status,
      source: classifySource(l as LeadLite),
      from_postcode: l.from_postcode,
      to_postcode: l.to_postcode,
      preferred_date: l.preferred_date,
      property_size: l.property_size,
      first_contacted_at: l.first_contacted_at,
      phone: l.phone,
      estimator_id: surveyEstimator.get(l.id) ?? null,
      submitted_at: l.submitted_at,
      created_at: l.created_at,
      value: v ? (v.accepted ?? v.latest) : null,
    };
  });

  // Monday of the current UK week — the board's default Mon–Sun window.
  const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const t = new Date(`${ukToday}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const thisWeekStart = t.toISOString().slice(0, 10);

  return (
    <main className="flex flex-1 flex-col p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Board" />
      <StatusBoard leads={cards} meId={user?.id ?? null} thisWeekStart={thisWeekStart} />
    </main>
  );
}
