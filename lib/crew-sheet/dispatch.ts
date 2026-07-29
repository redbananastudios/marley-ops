/**
 * Night-before crew job-sheet dispatch — the engine behind
 * app/api/cron/crew-job-sheets. On each run (every few minutes) it, for today
 * and tomorrow:
 *   1. assembles every assigned crew member's day sheet (lib/crew-sheet/daily-data),
 *   2. sends the initial copy once the 18:00-the-evening-before window opens,
 *   3. detects a content change (a job moved/re-crewed/cancelled) and re-sends a
 *      clearly-superseding copy,
 *   4. retries a transient email/SMS failure without ever re-sending delivered
 *      content,
 * emailing a PDF and texting a login-less /sheet/<token> link, and logging every
 * attempt to crew_job_sheet_sends for the office.
 *
 * Idempotent: the delivered-hash ledger means a re-run (or the next cron tick)
 * never double-sends the same sheet. Single-sender under concurrency via an
 * ignore-duplicate insert + a content-hash-guarded update.
 */

import { randomBytes } from "node:crypto";
import { ukInstant, ukParts, UK_TZ } from "@/lib/uk-time";
import { sendEmail, sendSms } from "@/lib/comms/send";
import { escapeHtml } from "@/lib/comms/escape-html";
import { renderPdfBase64 } from "@/lib/pdf/server-pdf";
import { assembleDaySheets, daySheetHash, type CrewDaySheet } from "./daily-data";
import { buildDaySheetDocDef } from "./daily-docdef";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = { from: (t: string) => any };

const SEND_HOUR = 18; // 18:00 UK the evening before — the PRD's send time.
const MAX_ATTEMPTS = 6; // ~30 min of 5-min retries before a hard failure gives up.
const PHOTOS_PER_JOB = 3; // survey photos embedded per job on the day sheet…
const PHOTOS_PER_DAY = 8; // …and a whole-day cap so a many-job PDF stays sane.

const appBase = (): string => (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, "");

const ukDayStr = (p: { year: number; month: number; day: number }): string =>
  `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

/** The two work-dates a run manages: today (catch same-day changes / additions)
 *  and tomorrow (the main night-before send). */
export function targetWorkDates(now: Date = new Date()): string[] {
  const p = ukParts(now);
  const today = ukDayStr(p);
  const tomorrow = ukDayStr(ukParts(new Date(ukInstant(p.year, p.month, p.day + 1).getTime())));
  return [today, tomorrow];
}

/** Has the 18:00-evening-before send window opened for this work-date? */
export function windowOpen(workDate: string, now: Date = new Date()): boolean {
  const [y, m, d] = workDate.split("-").map(Number);
  // Window opens at SEND_HOUR the previous calendar day.
  return now.getTime() >= ukInstant(y, m, d - 1, SEND_HOUR).getTime();
}

export interface SheetStateRow {
  id: string;
  version: number;
  content_hash: string;
  delivered_hash: string | null;
  attempts: number;
  token: string;
}

export type SheetDecision =
  | { kind: "wait" } // not eligible yet (before the window), no row
  | { kind: "done" } // current content already delivered, or retries exhausted
  | { kind: "send"; contentChanged: boolean; superseding: boolean };

/** Pure decision: given the current content hash and the stored row, what should
 *  this pass do? Keeps the send/retry/supersede rules unit-testable. */
export function decideSheetAction(params: {
  currentHash: string;
  eligible: boolean;
  row: SheetStateRow | null;
  maxAttempts?: number;
}): SheetDecision {
  const { currentHash, eligible, row } = params;
  const maxAttempts = params.maxAttempts ?? MAX_ATTEMPTS;
  if (!row) return eligible ? { kind: "send", contentChanged: true, superseding: false } : { kind: "wait" };
  if (row.delivered_hash === currentHash) return { kind: "done" };
  const contentChanged = row.content_hash !== currentHash;
  if (contentChanged) return { kind: "send", contentChanged: true, superseding: row.delivered_hash != null };
  // Same content, not yet delivered → retry until the cap.
  if (row.attempts < maxAttempts) return { kind: "send", contentChanged: false, superseding: row.delivered_hash != null };
  return { kind: "done" };
}

const genToken = (): string => randomBytes(18).toString("base64url");

const fmtLongDate = (d: string): string =>
  new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const fmtShortDate = (d: string): string =>
  new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const generatedLabel = (now: Date): string => {
  const p = ukParts(now);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const day = new Date(now).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: UK_TZ });
  return `${hhmm} on ${day}`;
};

/** SMS body (kept short). Login-less link to the current sheet. */
export function smsBody(day: CrewDaySheet, url: string, superseding: boolean): string {
  const when = fmtShortDate(day.workDate);
  const n = day.jobs.length;
  const jobs = n === 0 ? "no jobs" : `${n} ${n === 1 ? "job" : "jobs"}`;
  const lead = superseding ? `Marley Moves UPDATE: your ${when} sheet changed` : `Marley Moves: your job sheet for ${when}`;
  return `${lead} (${jobs}). ${url} Questions? 01747 637070`;
}

/** Email HTML — brief body; the PDF is attached and the web version linked. */
export function emailHtml(day: CrewDaySheet, url: string, superseding: boolean): string {
  const first = escapeHtml((day.crew.fullName || "").trim().split(/\s+/)[0] || "there");
  const when = escapeHtml(fmtLongDate(day.workDate));
  const n = day.jobs.length;
  const jobsLine =
    n === 0
      ? "Your jobs for this day have changed. You now have <strong>no jobs</strong> booked. Please check with the office if that's a surprise."
      : `You're on <strong>${n} ${n === 1 ? "job" : "jobs"}</strong>.`;
  const banner = superseding
    ? `<tr><td style="padding:12px 24px;background:#FEF3E2;border-bottom:1px solid #F5D9A8;font-size:13px;color:#B45309;"><strong>Updated sheet.</strong> A job changed. This replaces the sheet we sent earlier.</td></tr>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F6F5F3;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #EAE7E2;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#2A2927;padding:18px 24px;">
        <span style="font-size:18px;font-weight:bold;color:#ffffff;">Marley <span style="color:#E85959;">Moves</span></span>
      </td></tr>
      ${banner}
      <tr><td style="padding:24px;">
        <p style="margin:0 0 6px;font-size:16px;color:#1F1D1B;"><strong>Hi ${first},</strong></p>
        <p style="margin:0 0 8px;font-size:14px;color:#1F1D1B;">Here's your job sheet for <strong>${when}</strong>.</p>
        <p style="margin:0 0 16px;font-size:14px;color:#6F6A64;">${jobsLine} Your full sheet is attached as a PDF, and you can open it on your phone any time with the link below.</p>
        <p style="margin:0 0 4px;">
          <a href="${escapeHtml(url)}" style="display:inline-block;background:#C03838;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 22px;border-radius:6px;">Open my job sheet</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#6F6A64;">Signal patchy on the road? The link works without logging in. Any questions, call the office on 01747 637070.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export interface DispatchSummary {
  now: string;
  dates: string[];
  considered: number;
  sent: number; // sheets (re)sent this run
  emailOk: number;
  emailFailed: number;
  smsOk: number;
  smsFailed: number;
  skippedNoContact: number;
  failures: { staff: string; date: string; channel: string; error: string }[];
}

/**
 * Run one dispatch pass. Assembles + delivers day sheets for today and tomorrow.
 */
export async function dispatchCrewJobSheets(admin: Admin, now: Date = new Date()): Promise<DispatchSummary> {
  const dates = targetWorkDates(now);
  const summary: DispatchSummary = {
    now: now.toISOString(),
    dates,
    considered: 0,
    sent: 0,
    emailOk: 0,
    emailFailed: 0,
    smsOk: 0,
    smsFailed: 0,
    skippedNoContact: 0,
    failures: [],
  };

  for (const workDate of dates) {
    const eligible = windowOpen(workDate, now);

    // Assembled crew (those with jobs) ∪ existing rows (to catch a crew member
    // whose jobs were ALL cancelled — they need a "you're now clear" sheet).
    const assembled = await assembleDaySheets(admin, workDate);
    const byStaff = new Map<string, CrewDaySheet>(assembled.map((d) => [d.crew.id, d]));

    const { data: rows } = await admin
      .from("crew_job_sheets")
      .select("id, staff_id, version, content_hash, delivered_hash, attempts, token")
      .eq("work_date", workDate);
    const rowByStaff = new Map<string, SheetStateRow & { staff_id: string }>(
      (rows ?? []).map((r: any) => [r.staff_id, r]),
    );

    // Existing rows whose crew no longer has any assembled job → empty day sheet.
    const emptyStaffIds = [...rowByStaff.keys()].filter((sid) => !byStaff.has(sid));
    if (emptyStaffIds.length) {
      const { data: staff } = await admin
        .from("staff")
        .select("id, full_name, email, phone")
        .eq("is_active", true) // don't email a "you're clear" sheet to a deactivated crew member
        .in("id", emptyStaffIds);
      for (const s of (staff ?? []) as any[]) {
        byStaff.set(s.id, {
          crew: { id: s.id, fullName: s.full_name, email: s.email ?? null, phone: s.phone ?? null },
          workDate,
          jobs: [],
        });
      }
    }

    for (const [staffId, day] of byStaff) {
      summary.considered++;
      const currentHash = daySheetHash(day);
      const row = rowByStaff.get(staffId) ?? null;
      const decision = decideSheetAction({ currentHash, eligible, row });
      if (decision.kind !== "send") continue;

      // ── Claim the work (atomic, single-sender) ─────────────────────────────
      let claimed: SheetStateRow;
      let version: number;
      if (!row) {
        const token = genToken();
        const { data: inserted } = await admin
          .from("crew_job_sheets")
          .upsert(
            { staff_id: staffId, work_date: workDate, version: 1, content_hash: currentHash, attempts: 0, token },
            { onConflict: "staff_id,work_date", ignoreDuplicates: true },
          )
          .select("id, version, content_hash, delivered_hash, attempts, token");
        const ins = (inserted ?? [])[0] as SheetStateRow | undefined;
        if (!ins) continue; // another pass created it — it will send.
        claimed = ins;
        version = 1;
      } else if (decision.contentChanged) {
        const { data: updated } = await admin
          .from("crew_job_sheets")
          .update({ content_hash: currentHash, version: row.version + 1, attempts: 0 })
          .eq("id", row.id)
          .eq("content_hash", row.content_hash) // CAS — lose the race → skip
          .select("id, version, content_hash, delivered_hash, attempts, token");
        const upd = (updated ?? [])[0] as SheetStateRow | undefined;
        if (!upd) continue;
        claimed = upd;
        version = row.version + 1;
      } else {
        // Retry of the same undelivered content. Claim atomically (CAS on
        // attempts) so two overlapping cron runs — a slow run isn't unusual with
        // many crew + PDF renders — can't both re-send the same sheet.
        const { data: updated } = await admin
          .from("crew_job_sheets")
          .update({ attempts: row.attempts + 1 })
          .eq("id", row.id)
          .eq("content_hash", row.content_hash)
          .eq("attempts", row.attempts) // CAS — lose the race → skip
          .select("id, version, content_hash, delivered_hash, attempts, token");
        const upd = (updated ?? [])[0] as SheetStateRow | undefined;
        if (!upd) continue;
        claimed = upd;
        version = row.version;
      }

      // ── Render + send ──────────────────────────────────────────────────────
      const url = `${appBase()}/sheet/${claimed.token}`;
      const superseding = decision.superseding;
      const meta = { version, supersedes: superseding, generatedAtLabel: generatedLabel(now) };

      // Attach survey photos (access shots, large items). Loaded lazily here and
      // deliberately kept OUT of the change-hash, so adding a photo doesn't spam
      // a re-send. Capped per job + per day so a many-job PDF stays a sane size.
      // Dynamic import: job-sheet-load pulls the `server-only` media-store chain,
      // which must not load in unit tests (they never reach this path).
      if (day.jobs.some((j) => j.surveyId)) {
        const { loadPhotoDataUris } = await import("@/lib/job-sheet-load");
        let budget = PHOTOS_PER_DAY;
        for (const job of day.jobs) {
          // A job object is shared across the crew-mates on it (daily-data fans
          // one DailyJob into every sheet). If a crew-mate's pass already loaded
          // its photos, reuse them instead of re-fetching from R2.
          if (job.sheet.photos !== undefined) {
            budget -= job.sheet.photos.length;
            continue;
          }
          if (budget <= 0 || !job.surveyId) {
            job.sheet.photos = [];
            continue;
          }
          try {
            const photos = await loadPhotoDataUris(admin as never, job.surveyId, Math.min(PHOTOS_PER_JOB, budget));
            job.sheet.photos = photos;
            budget -= photos.length;
          } catch {
            job.sheet.photos = []; // a photo store hiccup never blocks the sheet
          }
        }
      }

      let pdfBase64: string | null = null;
      try {
        pdfBase64 = await renderPdfBase64(buildDaySheetDocDef(day, meta));
      } catch (err) {
        // A render failure shouldn't wedge the row; log a failed "email" attempt
        // and let the next pass retry (attempts still increments below).
        summary.failures.push({
          staff: day.crew.fullName,
          date: workDate,
          channel: "pdf",
          error: err instanceof Error ? err.message : "PDF render failed",
        });
      }

      let anyOk = false;
      const filename = `Marley-Day-Sheet-${workDate}.pdf`;
      const logs: { channel: "email" | "sms"; status: "sent" | "failed" | "skipped"; recipient: string | null; provider: string | null; error: string | null }[] = [];

      // Email (with the PDF attached)
      if (day.crew.email && pdfBase64) {
        const res = await sendEmail({
          to: day.crew.email,
          subject: `${superseding ? "Updated job sheet" : "Your job sheet"}: ${fmtLongDate(workDate)}`,
          html: emailHtml(day, url, superseding),
          attachments: [{ filename, content: pdfBase64 }],
          replyTo: "hello@marleymoves.co.uk",
        });
        if (res.ok) {
          anyOk = true;
          summary.emailOk++;
        } else {
          summary.emailFailed++;
          summary.failures.push({ staff: day.crew.fullName, date: workDate, channel: "email", error: res.error ?? "email failed" });
        }
        logs.push({ channel: "email", status: res.ok ? "sent" : "failed", recipient: day.crew.email, provider: res.providerId ?? null, error: res.ok ? null : res.error ?? "email failed" });
      } else if (day.crew.email && !pdfBase64) {
        logs.push({ channel: "email", status: "failed", recipient: day.crew.email, provider: null, error: "PDF render failed" });
      } else {
        logs.push({ channel: "email", status: "skipped", recipient: null, provider: null, error: "no email on file" });
      }

      // SMS (login-less web link)
      if (day.crew.phone) {
        const res = await sendSms({ to: day.crew.phone, body: smsBody(day, url, superseding) });
        if (res.ok) {
          anyOk = true;
          summary.smsOk++;
        } else {
          summary.smsFailed++;
          summary.failures.push({ staff: day.crew.fullName, date: workDate, channel: "sms", error: res.error ?? "sms failed" });
        }
        logs.push({ channel: "sms", status: res.ok ? "sent" : "failed", recipient: day.crew.phone, provider: res.providerId ?? null, error: res.ok ? null : res.error ?? "sms failed" });
      } else {
        logs.push({ channel: "sms", status: "skipped", recipient: null, provider: null, error: "no phone on file" });
      }

      const noContact = !day.crew.email && !day.crew.phone;
      if (noContact) {
        summary.skippedNoContact++;
        // Surface WHO can't be reached (once — the row is marked terminal below
        // so this crew isn't reprocessed every pass).
        summary.failures.push({ staff: day.crew.fullName, date: workDate, channel: "none", error: "no email or phone on file" });
      }
      if (anyOk) summary.sent++;

      // Log every attempt.
      if (logs.length) {
        await admin.from("crew_job_sheet_sends").insert(
          logs.map((l) => ({
            sheet_id: claimed.id,
            version,
            channel: l.channel,
            status: l.status,
            superseding,
            recipient: l.recipient,
            provider_id: l.provider,
            error: l.error,
          })),
        );
      }

      // Advance the state: bump attempts; on ANY successful channel mark this
      // content delivered. Any-channel (not both) is deliberate: the email and
      // the SMS both carry the SAME login-less /sheet link (the email also
      // attaches the PDF), so an email-OK / SMS-failed crew member already has
      // their sheet — we don't re-send (which would re-email) to chase the SMS.
      // The failed SMS is still logged status='failed' and shown on the office
      // failure panel so a bad number gets fixed.
      // A crew member with no email AND no phone can never be reached — mark the
      // attempts terminal so we don't burn a full retry cycle (and re-log skipped
      // rows) every pass on them.
      const prevAttempts = decision.contentChanged || !row ? 0 : row.attempts;
      await admin
        .from("crew_job_sheets")
        .update({
          attempts: noContact ? MAX_ATTEMPTS : prevAttempts + 1,
          ...(anyOk ? { delivered_hash: currentHash, delivered_at: now.toISOString() } : {}),
        })
        .eq("id", claimed.id);
    }
  }

  return summary;
}
