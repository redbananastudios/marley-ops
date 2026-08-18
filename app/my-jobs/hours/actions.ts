"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";
import { likeEscape } from "@/lib/util/like";
import { entryHours, parseTimeOfDay } from "@/lib/staff/time-entries";
import { MAX_LINE_AMOUNT } from "@/lib/staff/statements";
import {
  emailReceiptToAccounts,
  isValidReceiptPath,
  MAX_RECEIPT_BYTES,
  RECEIPT_CONTENT_TYPES,
  receiptStore,
} from "@/lib/staff/receipts";
import { isValidDeclaredUploadSize } from "@/lib/storage/upload-limits";
import type { MediaUploadTarget } from "@/lib/storage/media-store";

const UK = "Europe/London";
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
// "HH:MM" from an <input type="time">; "" = cleared.
const timeOfDay = z.union([z.literal(""), z.string().trim().regex(/^\d{2}:\d{2}$/, "Invalid time")]);

/** How far back a day can still be logged. Generous on purpose — "some crew
 *  may forget and do 2 days together or may not do until end of week" — the
 *  real lock is the invoice, not the calendar. */
const MAX_BACKFILL_DAYS = 90;

/** Resolve the caller's own active staff row (profile-id first, email-match
 *  self-heal second — the same login→crew link every /my-jobs surface uses).
 *  No self-billing/agreement gates here: logging hours is record-keeping, not
 *  invoicing, so it must work even before the office switches invoicing on. */
type StaffCtx =
  | { error: string }
  | {
      error?: undefined;
      sb: Awaited<ReturnType<typeof createClient>>;
      profileId: string;
      staff: { id: string; full_name: string };
    };

async function meAsStaff(): Promise<StaffCtx> {
  const sb = await createClient();
  const profile = await getSessionProfile();
  if (!profile?.active) return { error: "Not signed in." as const };

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
      .ilike("email", likeEscape(profile.email))
      .eq("is_active", true)
      .maybeSingle();
    staffRow = byEmail ?? null;
    if (byEmail) await sb.from("staff").update({ profile_id: profile.id }).eq("id", byEmail.id);
  }
  if (!staffRow) return { error: "Your login isn’t linked to a crew record yet." as const };
  return { sb, profileId: profile.id, staff: staffRow };
}

/** A day is locked once a SUBMITTED or PAID invoice covers it — the entry is
 *  the evidence behind that invoice, so it can't quietly drift afterwards. A
 *  draft doesn't lock (the crew are still building that week). */
async function dayLocked(
  sb: Awaited<ReturnType<typeof createClient>>,
  staffId: string,
  workDate: string,
): Promise<string | null> {
  const { data } = await sb
    .from("staff_statements")
    .select("ref, status")
    .eq("staff_id", staffId)
    .lte("period_start", workDate)
    .gte("period_end", workDate)
    .in("status", ["submitted", "paid"])
    .limit(1)
    .maybeSingle();
  return data ? data.ref : null;
}

function dateBoundsError(workDate: string): string | null {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  if (workDate > today) return "You can’t log hours for a day that hasn’t happened yet.";
  const floor = new Date(`${today}T00:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - MAX_BACKFILL_DAYS);
  if (workDate < floor.toISOString().slice(0, 10)) return "That day is too far back — ask the office to record it.";
  return null;
}

const upsertSchema = z.object({
  work_date: isoDate,
  started_at: timeOfDay.optional(),
  ended_at: timeOfDay.optional(),
  expense_amount: z.union([z.literal(""), z.coerce.number().nonnegative()]).optional(),
  expense_note: z.string().trim().max(200).optional(),
});

export type TimeEntryDto = {
  work_date: string;
  started_at: string | null;
  ended_at: string | null;
  expense_amount: number | null;
  expense_note: string | null;
  has_receipt: boolean;
  receipt_emailed: boolean;
};

/** Save one day's record: start/finish times and/or the day's expense. Both
 *  halves are optional so a receipt can land before the hours are filled in —
 *  but whatever IS entered must be coherent. */
export async function upsertMyTimeEntryAction(
  input: z.infer<typeof upsertSchema>,
): Promise<{ ok: true; entry: TimeEntryDto } | { ok: false; error: string }> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await meAsStaff();
  if (ctx.error != null) return { ok: false, error: ctx.error };
  const { sb, staff } = ctx;
  const d = parsed.data;

  const boundsErr = dateBoundsError(d.work_date);
  if (boundsErr) return { ok: false, error: boundsErr };
  const lockedRef = await dayLocked(sb, staff.id, d.work_date);
  if (lockedRef) return { ok: false, error: `That day is already on invoice ${lockedRef} — ask the office to amend it.` };

  const started = d.started_at || null;
  const ended = d.ended_at || null;
  // One time without the other saves fine (they can finish the entry later),
  // but a PAIR must make sense — finish after start, same day.
  if (started && ended && entryHours(started, ended) == null) {
    return { ok: false, error: "The finish time must be after the start. Work past midnight? Log it as two days." };
  }
  if ((started && parseTimeOfDay(started) == null) || (ended && parseTimeOfDay(ended) == null)) {
    return { ok: false, error: "Invalid time." };
  }

  const amount = d.expense_amount === "" || d.expense_amount == null ? null : Number(d.expense_amount);
  if (amount != null && amount > MAX_LINE_AMOUNT) {
    return { ok: false, error: "That expense looks too large — check the amount." };
  }
  const note = d.expense_note?.trim() || null;

  const { data: row, error } = await sb
    .from("staff_time_entries")
    .upsert(
      {
        staff_id: staff.id,
        work_date: d.work_date,
        started_at: started,
        ended_at: ended,
        expense_amount: amount != null && amount > 0 ? amount : null,
        expense_note: note,
      },
      { onConflict: "staff_id,work_date" },
    )
    .select("work_date, started_at, ended_at, expense_amount, expense_note, receipt_key, receipt_emailed_at")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn’t save — try again." };

  revalidatePath("/my-jobs/hours");
  revalidatePath("/my-jobs/pay");
  return {
    ok: true,
    entry: {
      work_date: row.work_date,
      started_at: row.started_at,
      ended_at: row.ended_at,
      expense_amount: row.expense_amount == null ? null : Number(row.expense_amount),
      expense_note: row.expense_note,
      has_receipt: !!row.receipt_key,
      receipt_emailed: !!row.receipt_emailed_at,
    },
  };
}

/** Wipe a day's record entirely (typo on the wrong day). The stored receipt
 *  photo is removed ONLY once its copy provably reached the mail pipeline —
 *  an un-emailed receipt is the only copy of a bookkeeping document, so it is
 *  left in storage (orphan lint beats destroyed evidence). */
export async function clearMyTimeEntryAction(input: { work_date: string }) {
  const parsed = z.object({ work_date: isoDate }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await meAsStaff();
  if (ctx.error != null) return { ok: false as const, error: ctx.error };
  const { sb, staff } = ctx;

  const lockedRef = await dayLocked(sb, staff.id, parsed.data.work_date);
  if (lockedRef) return { ok: false as const, error: `That day is already on invoice ${lockedRef} — ask the office to amend it.` };

  const { data: existing } = await sb
    .from("staff_time_entries")
    .select("id, receipt_key, receipt_emailed_at")
    .eq("staff_id", staff.id)
    .eq("work_date", parsed.data.work_date)
    .maybeSingle();
  if (!existing) return { ok: true as const };

  const { error } = await sb.from("staff_time_entries").delete().eq("id", existing.id);
  if (error) return { ok: false as const, error: error.message };
  if (existing.receipt_key && existing.receipt_emailed_at) {
    try {
      await receiptStore().deleteObjects([existing.receipt_key]);
    } catch {
      /* orphaned object only — the row is gone, the email already carries the copy */
    }
  }

  revalidatePath("/my-jobs/hours");
  revalidatePath("/my-jobs/pay");
  return { ok: true as const };
}

/** Mint a presigned upload target for a receipt photo, scoped to the caller's
 *  own `<staffId>/<workDate>/<uuid>.<ext>` path and the declared size. */
export async function createReceiptUploadTargetAction(input: {
  work_date: string;
  ext: string;
  mime: string;
  bytes: number;
}): Promise<{ ok: true; target: MediaUploadTarget; path: string } | { ok: false; error: string }> {
  const parsed = z
    .object({
      work_date: isoDate,
      ext: z.enum(["jpg", "jpeg", "png", "webp", "heic", "heif"]),
      mime: z.string().max(100),
      bytes: z.number(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid upload." };
  const ctx = await meAsStaff();
  if (ctx.error != null) return { ok: false, error: ctx.error };
  const { sb, staff } = ctx;

  const boundsErr = dateBoundsError(parsed.data.work_date);
  if (boundsErr) return { ok: false, error: boundsErr };
  const lockedRef = await dayLocked(sb, staff.id, parsed.data.work_date);
  if (lockedRef) return { ok: false, error: `That day is already on invoice ${lockedRef}.` };
  if (!isValidDeclaredUploadSize(parsed.data.bytes, MAX_RECEIPT_BYTES)) {
    return { ok: false, error: "That photo is too large — keep it under 10 MB." };
  }

  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) return { ok: false, error: "Session expired — sign in again." };

  const path = `${staff.id}/${parsed.data.work_date}/${randomUUID()}.${parsed.data.ext}`;
  // Exact whitelist, not startsWith("image/") — image/svg+xml is scriptable
  // markup wearing an image mask. The content-type is baked into the presigned
  // signature, so storage itself enforces this.
  const contentType = (RECEIPT_CONTENT_TYPES as readonly string[]).includes(parsed.data.mime)
    ? parsed.data.mime
    : "image/jpeg";
  try {
    const target = await receiptStore().createUploadTarget({
      objectKey: path,
      contentType,
      accessToken: session.access_token,
      sizeBytes: parsed.data.bytes,
    });
    return { ok: true, target, path };
  } catch {
    return { ok: false, error: "Storage is not configured." };
  }
}

/** After the browser uploads the photo: verify it actually landed, attach it
 *  to the day's entry, and email the copy to accounts@. */
export async function recordReceiptAction(input: {
  work_date: string;
  path: string;
}): Promise<{ ok: true; emailed: boolean } | { ok: false; error: string }> {
  const parsed = z.object({ work_date: isoDate, path: z.string().max(300) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const ctx = await meAsStaff();
  if (ctx.error != null) return { ok: false, error: ctx.error };
  const { sb, profileId, staff } = ctx;
  const { work_date, path } = parsed.data;

  // The path is the security seam: it must name the caller's OWN staff id and
  // this exact day, so nobody can attach an object outside their own prefix.
  if (!isValidReceiptPath(path, staff.id, work_date)) return { ok: false, error: "Invalid upload path." };
  const lockedRef = await dayLocked(sb, staff.id, work_date);
  if (lockedRef) return { ok: false, error: `That day is already on invoice ${lockedRef}.` };

  // Never record a path whose upload didn't complete — an orphan row would
  // read as "receipt held" with nothing behind it. Reading the BYTES here (not
  // just metadata) means nothing can fail between this point and the mail
  // pipeline durably claiming the send.
  let imageBase64: string;
  try {
    const bytes = await receiptStore().getObject(path);
    if (!bytes.length) return { ok: false, error: "The upload didn’t finish — try again." };
    imageBase64 = Buffer.from(bytes).toString("base64");
  } catch {
    return { ok: false, error: "The upload didn’t finish — try again." };
  }

  const { data: existing } = await sb
    .from("staff_time_entries")
    .select("id, receipt_key, receipt_emailed_at, expense_amount, expense_note")
    .eq("staff_id", staff.id)
    .eq("work_date", work_date)
    .maybeSingle();

  // Receipt columns are server-attested (0099 column grants keep them out of
  // the authenticated role's writable set), so this write goes through the
  // service role — AFTER the ownership + path checks above proved the claim.
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("staff_time_entries")
    .upsert(
      { staff_id: staff.id, work_date, receipt_key: path, receipt_emailed_at: null },
      { onConflict: "staff_id,work_date" },
    )
    .select("id, expense_amount, expense_note")
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "Couldn’t save the receipt — try again." };

  // Replacing a receipt: drop the old object once the new one is recorded —
  // but only if its copy provably went; an un-emailed old photo is the only
  // copy of a bookkeeping document.
  if (existing?.receipt_key && existing.receipt_key !== path && existing.receipt_emailed_at) {
    try {
      await receiptStore().deleteObjects([existing.receipt_key]);
    } catch {
      /* best-effort — an orphaned old photo is storage lint, not a data bug */
    }
  }

  const emailed = await emailReceiptToAccounts({
    actorId: profileId,
    staffName: staff.full_name,
    workDate: work_date,
    objectKey: path,
    imageBase64,
    expenseAmount: row.expense_amount == null ? null : Number(row.expense_amount),
    expenseNote: row.expense_note,
  });
  if (emailed) {
    // Stamp only if this path is still the row's receipt — a concurrent
    // replacement must not inherit a stamp earned by the photo it replaced.
    await admin
      .from("staff_time_entries")
      .update({ receipt_emailed_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("receipt_key", path);
  }

  revalidatePath("/my-jobs/hours");
  return { ok: true, emailed };
}
