import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/comms/send";
import { HELLO_FROM, MARLEY_EMAIL_DOMAIN } from "@/lib/comms/sender";
import { buildWeeklyDigest, digestWeeks, type DigestInputs } from "@/lib/digest/weekly";
import { buildDigestEmailHtml, digestSubject } from "@/lib/digest/email";

/**
 * Weekly owner digest (Mondays 06:00 UTC via /etc/cron.d/marley-ops): a short
 * "how did the business run last week vs the week before" email to the ACTIVE
 * ADMINS with company-domain logins (today: Connor + Peter — Peter's spec,
 * 2026-07-16). Internal report — direct sendEmail, no Comms log.
 *
 * `?to=<address>` (office session or cron secret) redirects a one-off preview
 * to that address instead of the admins — used to eyeball the layout without
 * emailing the team.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const previewTo = new URL(req.url).searchParams.get("to");

  const run = await runCron("weekly-digest", async () => {
    const sb = createAdminClient();
    const now = new Date();
    const { lastWeek } = digestWeeks(now);
    const since = lastWeek.start.toISOString();

    const [leads, quotes, completions, appointments, bankPending, followUps, units, lets, claims] =
      await Promise.all([
        sb
          .from("leads")
          .select("id, created_at, lost_at, balance_paid_at")
          .or(`created_at.gte.${since},lost_at.gte.${since},balance_paid_at.gte.${since}`)
          .limit(2000),
        sb
          .from("quotes")
          .select(
            "lead_id, quote_ref, customer_name, email_sent_at, accepted_at, deposit_paid_at, deposit_amount, agreed_price, grand_total, balance_invoice_amount",
          )
          .or(
            `email_sent_at.gte.${since},accepted_at.gte.${since},deposit_paid_at.gte.${since},balance_invoice_amount.gt.0`,
          )
          .limit(2000),
        sb.from("job_completions").select("created_at, exceptions").gte("created_at", since).limit(1000),
        sb
          .from("appointments")
          .select("appt_type, status, starts_at")
          .gte("starts_at", since)
          .lte("starts_at", new Date(now.getTime() + 8 * 86_400_000).toISOString())
          .limit(2000),
        sb
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .in("status", ["suggested", "unmatched"]),
        sb.from("follow_ups").select("id", { count: "exact", head: true }).eq("status", "open"),
        sb.from("storage_units").select("id", { count: "exact", head: true }).eq("is_active", true),
        sb.from("storage_lets").select("id", { count: "exact", head: true }).is("end_date", null),
        sb
          .from("claims")
          .select("id", { count: "exact", head: true })
          .in("status", ["open", "assessing", "offer_made"]),
      ]);

    const input: DigestInputs = {
      leads: (leads.data ?? []) as DigestInputs["leads"],
      quotes: (quotes.data ?? []) as DigestInputs["quotes"],
      completions: (completions.data ?? []) as DigestInputs["completions"],
      appointments: (appointments.data ?? []) as DigestInputs["appointments"],
      snapshot: {
        bankTransfersPending: bankPending.count ?? 0,
        openFollowUps: followUps.count ?? 0,
        storageUnitsActive: units.count ?? 0,
        storageLetsOpen: lets.count ?? 0,
        openClaims: claims.count ?? 0,
      },
    };
    const digest = buildWeeklyDigest(input, now);

    // Recipients: active admins whose login is on the company domain — exactly
    // Connor + Peter today; a future admin joins automatically, a .test or
    // personal login never receives business figures.
    let recipients: string[];
    if (previewTo) {
      recipients = [previewTo];
    } else if (process.env.WEEKLY_DIGEST_EMAILS) {
      recipients = process.env.WEEKLY_DIGEST_EMAILS.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const { data: admins } = await sb
        .from("profiles")
        .select("email")
        .eq("role", "admin")
        .eq("active", true);
      recipients = (admins ?? [])
        .map((a) => (a.email ?? "").toLowerCase())
        .filter((e) => e.endsWith(`@${MARLEY_EMAIL_DOMAIN}`));
    }

    let sent = 0;
    const errors: string[] = [];
    for (const to of recipients) {
      const res = await sendEmail({
        to,
        from: HELLO_FROM,
        subject: digestSubject(digest),
        html: buildDigestEmailHtml(digest),
      });
      if (res.ok) sent += 1;
      else errors.push(`${to}: ${res.error ?? "send failed"}`);
    }

    return {
      week: digest.thisWeek.label,
      moneyIn: digest.thisWeek.moneyIn,
      wins: digest.thisWeek.wins,
      recipients: recipients.length,
      sent,
      preview: !!previewTo,
      ...(errors.length ? { errors } : {}),
    };
  });

  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
