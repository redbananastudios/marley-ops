import { NextResponse } from "next/server";
import { requireOfficeOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
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
 * `?to=<address>` (ADMIN session only) redirects a one-off preview to that
 * address instead of the admins — used to eyeball the layout without emailing
 * the team.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Shared by both quote fetches so the merged rows carry identical columns. */
const QUOTE_COLS =
  "id, lead_id, quote_ref, customer_name, email_sent_at, accepted_at, deposit_paid_at, deposit_amount, agreed_price, grand_total, balance_invoice_amount";

export async function GET(req: Request) {
  const caller = await requireOfficeOrCronSecret(req);
  if (!caller) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const previewTo = new URL(req.url).searchParams.get("to");
  // ?to= mails the full financial picture to an arbitrary address — admin
  // sessions only (the crontab call never carries it).
  if (previewTo && !(caller.via === "session" && caller.role === "admin")) {
    return NextResponse.json({ error: "Preview requires an admin session" }, { status: 403 });
  }

  const run = await runCron("weekly-digest", async () => {
    const sb = createAdminClient();
    const now = new Date();
    const { lastWeek } = digestWeeks(now);
    const since = lastWeek.start.toISOString();

    const [leads, quotes, completions, appointments, bankPending, followUps, units, lets, claims] =
      await Promise.all([
        // .limit(2000) is a lie — PostgREST hard-caps every response at 1000
        // rows, so these windowed reads would silently drop digest data if a
        // busy week ever exceeded it. Page through fetchAllRows and keep the
        // { data } shape the digest inputs below read. Ordered by id so the
        // range() windows are stable; the digest aggregates order-independently.
        fetchAllRows((f, t) =>
          sb
            .from("leads")
            .select("id, created_at, lost_at, balance_paid_at")
            .or(`created_at.gte.${since},lost_at.gte.${since},balance_paid_at.gte.${since}`)
            .order("id")
            .range(f, t),
        ).then((data) => ({ data })),
        fetchAllRows((f, t) =>
          sb
            .from("quotes")
            .select(QUOTE_COLS)
            .or(
              `email_sent_at.gte.${since},accepted_at.gte.${since},deposit_paid_at.gte.${since},balance_invoice_amount.gt.0`,
            )
            .order("id")
            .range(f, t),
        ).then((data) => ({ data })),
        sb.from("job_completions").select("created_at, exceptions").gte("created_at", since).limit(1000),
        fetchAllRows((f, t) =>
          sb
            .from("appointments")
            .select("appt_type, status, starts_at")
            .gte("starts_at", since)
            .lte("starts_at", new Date(now.getTime() + 8 * 86_400_000).toISOString())
            .order("id")
            .range(f, t),
        ).then((data) => ({ data })),
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

    // Balance leg the .or() above can miss: on the normal house-move timeline
    // the quote is sent/accepted and the deposit paid WEEKS before the move,
    // with no balance invoice — no fetch arm matches, so the balance paid this
    // window would value at £0. Fetch the paying leads' quotes explicitly and
    // merge by quote id.
    type QuoteRow = DigestInputs["quotes"][number] & { id: string };
    const quoteById = new Map<string, QuoteRow>();
    for (const q of (quotes.data ?? []) as QuoteRow[]) quoteById.set(q.id, q);
    const sinceT = lastWeek.start.getTime();
    const paidLeadIds = [
      ...new Set(
        ((leads.data ?? []) as DigestInputs["leads"])
          .filter((l) => l.balance_paid_at && Date.parse(l.balance_paid_at) >= sinceT)
          .map((l) => l.id),
      ),
    ];
    // Chunked .in() — hundreds of uuids in one GET blows the gateway URL limit.
    for (let i = 0; i < paidLeadIds.length; i += 100) {
      const { data } = await sb.from("quotes").select(QUOTE_COLS).in("lead_id", paidLeadIds.slice(i, i + 100));
      for (const q of (data ?? []) as QuoteRow[]) quoteById.set(q.id, q);
    }

    const input: DigestInputs = {
      leads: (leads.data ?? []) as DigestInputs["leads"],
      quotes: [...quoteById.values()],
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
