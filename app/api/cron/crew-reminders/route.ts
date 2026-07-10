import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/comms/send";
import { apptDays, apptWindow } from "@/lib/job-board";

/**
 * Night-before crew reminders (daily Vercel cron, ~18:00 UK). Every staff
 * member with an email and an assignment TOMORROW gets one email listing
 * their jobs and pointing at /my-jobs. reminded_at on the assignment makes
 * the cron idempotent — a retry or manual run never double-sends.
 *
 * Deliberately price-free, like everything crew-facing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UK = "Europe/London";
const OPS_URL = "https://ops.marleymoves.co.uk/my-jobs";

function ukDayPlus(days: number): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function prettyDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function reminderHtml(firstName: string, dayLabel: string, jobs: { line: string }[]): string {
  const rows = jobs
    .map(
      (j) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #EAE7E2;font-size:14px;color:#1F1D1B;">${esc(j.line)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F6F5F3;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #EAE7E2;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#2A2927;padding:18px 24px;">
        <span style="font-size:18px;font-weight:bold;color:#ffffff;">Marley <span style="color:#E85959;">Moves</span></span>
      </td></tr>
      <tr><td style="padding:24px;">
        <p style="margin:0 0 6px;font-size:16px;color:#1F1D1B;"><strong>Hi ${esc(firstName)},</strong></p>
        <p style="margin:0 0 16px;font-size:14px;color:#6F6A64;">You're on ${jobs.length === 1 ? "a job" : `${jobs.length} jobs`} <strong>${esc(dayLabel)}</strong>:</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EAE7E2;border-radius:6px;">${rows}</table>
        <p style="margin:20px 0 0;">
          <a href="${OPS_URL}" style="display:inline-block;background:#C03838;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 22px;border-radius:6px;">See my jobs</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#6F6A64;">Log in to see the full details and download your job sheet. Any questions, call the office on 01747 637070.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const tomorrow = ukDayPlus(1);

  // Un-reminded assignments joined to a window of appointments around tomorrow
  // (multi-day moves can START days earlier and still span tomorrow).
  const { data: assigns } = await admin
    .from("appointment_assignments")
    .select("id, staff_id, appointment_id")
    .not("staff_id", "is", null)
    .is("reminded_at", null);
  const apptIds = [...new Set((assigns ?? []).map((a) => a.appointment_id))];
  if (!apptIds.length) return NextResponse.json({ ok: true, sent: 0, reason: "no unreminded assignments" });

  const { data: appts } = await admin
    .from("appointments")
    .select("id, title, starts_at, ends_at, all_day, appt_type, lead_id, status")
    .in("id", apptIds)
    .neq("status", "cancelled");
  const tomorrowAppts = new Map(
    (appts ?? []).filter((a) => a.starts_at && apptDays(a).includes(tomorrow)).map((a) => [a.id, a]),
  );
  if (!tomorrowAppts.size) return NextResponse.json({ ok: true, sent: 0, reason: "nothing on tomorrow" });

  const due = (assigns ?? []).filter((a) => tomorrowAppts.has(a.appointment_id));
  const staffIds = [...new Set(due.map((a) => a.staff_id))] as string[];
  const leadIds = [...new Set([...tomorrowAppts.values()].map((a) => a.lead_id).filter(Boolean))] as string[];

  const [{ data: staff }, { data: leads }] = await Promise.all([
    admin.from("staff").select("id, full_name, email").in("id", staffIds).eq("is_active", true),
    leadIds.length
      ? admin.from("leads").select("id, name, from_postcode, to_postcode").in("id", leadIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; from_postcode: string | null; to_postcode: string | null }[] }),
  ]);
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  let sent = 0;
  let failed = 0;
  const remindedIds: string[] = [];

  for (const s of staff ?? []) {
    if (!s.email) continue;
    const mine = due.filter((a) => a.staff_id === s.id);
    if (!mine.length) continue;
    const jobs = mine.map((a) => {
      const appt = tomorrowAppts.get(a.appointment_id)!;
      const lead = appt.lead_id ? leadById.get(appt.lead_id) : null;
      const kind = appt.appt_type === "removal" ? "Move" : "Survey";
      const route =
        lead?.from_postcode || lead?.to_postcode ? ` · ${lead?.from_postcode ?? "?"} → ${lead?.to_postcode ?? "?"}` : "";
      return { line: `${apptWindow(appt)} — ${kind}: ${lead?.name ?? appt.title ?? "job"}${route}` };
    });

    const dayLabel = `tomorrow (${prettyDay(tomorrow)})`;
    const firstName = s.full_name.split(" ")[0] ?? s.full_name;
    const res = await sendEmail({
      to: s.email,
      subject: `You're on ${jobs.length === 1 ? "a job" : `${jobs.length} jobs`} tomorrow — ${prettyDay(tomorrow)}`,
      html: reminderHtml(firstName, dayLabel, jobs),
      replyTo: "hello@marleymoves.co.uk",
    });
    if (res.ok) {
      sent++;
      remindedIds.push(...mine.map((a) => a.id));
    } else {
      failed++;
      console.error(`[crew-reminders] send failed for ${s.full_name}: ${res.error}`);
    }
  }

  if (remindedIds.length) {
    await admin
      .from("appointment_assignments")
      .update({ reminded_at: new Date().toISOString() })
      .in("id", remindedIds);
  }

  return NextResponse.json({ ok: true, tomorrow, sent, failed, assignmentsMarked: remindedIds.length });
}
