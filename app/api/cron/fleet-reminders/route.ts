import { NextResponse } from "next/server";
import { requireOfficeOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { log } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { sendEmail } from "@/lib/comms/send";
import { sendPushForEvent } from "@/lib/push/send";
import { fleetExpiryDigestPush } from "@/lib/push/categories";
import { dueReminders, type FleetVehicle, type ReminderLogRow } from "@/lib/fleet/reminders";
import { fleetDigestHtml, fleetDigestSubject, type DigestItem } from "@/lib/fleet/reminder-email";

/**
 * Daily fleet-expiry reminders (Vercel cron, ~07:00 UK). Scans active vehicles
 * and, for each MOT / Tax / Insurance / Service / Lease date crossing a
 * threshold (28/14/7/3/day-of, then weekly overdue), sends ONE digest email to
 * the fleet-alert recipients + a digest push to office devices, then records
 * every fired threshold so nothing sends twice (vehicle_reminder_log).
 *
 * Gated by business_settings.fleet_reminders_enabled AND a non-empty recipient
 * list — with no recipients configured we send nothing and log nothing, so the
 * pending items still email once the addresses land (the dashboard card shows
 * them live in the meantime).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  // Office session or the cron secret — this route runs on the service-role
  // admin client and sends real emails/pushes, so crew sessions are refused
  // (matches the finance/digest crons; least privilege).
  if (!(await requireOfficeOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = await runCron("fleet-reminders", async () => {
    const admin = createAdminClient();

    const { data: settings } = await admin
      .from("business_settings")
      .select("fleet_reminders_enabled, fleet_alert_recipients")
      .eq("id", true)
      .maybeSingle();
    if (!settings?.fleet_reminders_enabled) return { skipped: "disabled" as const, due: 0 };
    const recipients = (settings.fleet_alert_recipients ?? []).filter((e): e is string => !!e);

    const { data: vehicles } = await admin
      .from("vehicles")
      .select("id, name, tax_due, mot_due, insurance_renewal, service_due, end_of_term")
      .eq("is_active", true);
    // Page the whole ledger — it grows one row per (vehicle, expiry, due_date,
    // threshold) forever, so an unbounded select would hit PostgREST's 1000-row
    // cap and silently drop "already sent" rows, re-sending old reminders.
    const logRows = await fetchAllRows((f, t) =>
      admin.from("vehicle_reminder_log").select("vehicle_id, expiry_type, due_date, threshold").order("id").range(f, t),
    );

    const fleet: FleetVehicle[] = (vehicles ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      tax_due: v.tax_due,
      mot_due: v.mot_due,
      insurance_renewal: v.insurance_renewal,
      service_due: v.service_due,
      end_of_term: v.end_of_term,
    }));

    const due = dueReminders(fleet, new Date(), (logRows ?? []) as ReminderLogRow[]);
    if (due.length === 0) return { due: 0 };
    if (recipients.length === 0) return { due: due.length, skipped: "no_recipients" as const };

    // One branded digest to each recipient.
    const items: DigestItem[] = due.map((d) => ({
      vehicleName: d.vehicle_name,
      expiryLabel: d.expiry_label,
      dueDate: d.due_date,
      days: d.days,
    }));
    const subject = fleetDigestSubject(items);
    const html = fleetDigestHtml(items);
    let sent = 0;
    for (const to of recipients) {
      const r = await sendEmail({ to, subject, html, replyTo: "hello@marleymoves.co.uk" });
      if (r.ok) sent += 1;
      else log.error("cron.fleet-reminders.send_failed", { to, error: r.error });
    }
    // Every recipient bounced — record nothing so the next run retries.
    if (sent === 0) return { due: due.length, emailed: 0 };

    // Best-effort push digest to office devices (never throws).
    const push = await sendPushForEvent(fleetExpiryDigestPush(due.length), { admin });

    // Claim every fired threshold — the never-send-twice ledger. ignoreDuplicates
    // makes a same-day re-run a no-op.
    const rows = due.flatMap((d) =>
      d.record.map((threshold) => ({
        vehicle_id: d.vehicle_id,
        expiry_type: d.expiry_type,
        due_date: d.due_date,
        threshold,
      })),
    );
    const { error: logErr } = await admin
      .from("vehicle_reminder_log")
      .upsert(rows, { onConflict: "vehicle_id,expiry_type,due_date,threshold", ignoreDuplicates: true });
    if (logErr) log.error("cron.fleet-reminders.log_failed", { error: logErr.message });

    return { due: due.length, emailed: sent, logged: rows.length, pushed: push.accepted };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
