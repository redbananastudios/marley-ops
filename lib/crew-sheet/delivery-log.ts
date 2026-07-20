/**
 * Office-facing read of the crew job-sheet delivery log — powers the failure
 * surface on /automations so a sheet that didn't reach a crew member is visible
 * rather than silent. Uses the caller's (office-session) client, so RLS on
 * crew_job_sheet_sends / crew_job_sheets applies.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = { from: (t: string) => any };

export interface SendFailure {
  staff: string;
  workDate: string;
  channel: string;
  error: string;
  at: string;
}

/** Failed sends in the last `hours` (default 48), newest first. */
export async function recentSendFailures(sb: Client, hours = 48): Promise<SendFailure[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data: sends } = await sb
    .from("crew_job_sheet_sends")
    .select("sheet_id, channel, error, created_at")
    .eq("status", "failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (sends ?? []) as any[];
  if (!rows.length) return [];

  const sheetIds = [...new Set(rows.map((r) => r.sheet_id))];
  const { data: sheets } = await sb
    .from("crew_job_sheets")
    .select("id, staff_id, work_date")
    .in("id", sheetIds);
  const sheetById = new Map(((sheets ?? []) as any[]).map((s) => [s.id, s]));

  const staffIds = [...new Set(((sheets ?? []) as any[]).map((s) => s.staff_id))];
  const { data: staff } = staffIds.length
    ? await sb.from("staff").select("id, full_name").in("id", staffIds)
    : { data: [] };
  const nameById = new Map(((staff ?? []) as any[]).map((s) => [s.id, s.full_name]));

  return rows.map((r) => {
    const sheet = sheetById.get(r.sheet_id);
    return {
      staff: (sheet && nameById.get(sheet.staff_id)) || "Unknown crew",
      workDate: sheet?.work_date ?? "",
      channel: r.channel,
      error: r.error ?? "failed",
      at: r.created_at,
    };
  });
}
