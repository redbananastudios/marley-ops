import "server-only";

import { createMediaStore } from "@/lib/storage/media-store";
import { dispatchComm } from "@/lib/comms/dispatch";
import { accountsFrom, opsAlertRecipient } from "@/lib/comms/sender";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Expense receipt photos (crew portal → accounts@). The photo lives in PRIVATE
 * object storage under its own logical bucket, and a copy is emailed to the
 * accounts money desk the moment it lands — that inbox is the bookkeeping
 * record (Peter, 2026-08-18: receipts "need to be emailed within the app or
 * API to accounts@marleymoves.co.uk").
 *
 * The email rides dispatchComm, NOT sendOpsAlert: a receipt that silently
 * fails to send is invisible money paperwork, so it gets the durable
 * communications row, the SMTP fallback and the comms-retry worker like any
 * customer email — and COMMS_DRYRUN keeps staging tests off the real inbox.
 * A sweep on the comms-retry cron re-sends any receipt whose stamp never
 * landed, so no failure mode ends at "we think it went".
 */

export const RECEIPTS_BUCKET = "expense-receipts";

/** Generous ceiling for one phone photo of a paper receipt. The client
 *  downscales to ~2000px JPEG first; this bounds the HEIC-decode-failure
 *  fallback (original file) so the emailed copy stays a sane attachment. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** The exact image types a receipt may claim. Content-type is part of the
 *  presigned upload signature, so this whitelist is enforced by storage itself —
 *  never image/svg+xml (scriptable) or anything non-image. */
export const RECEIPT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

export const receiptStore = () => createMediaStore(process.env, { bucket: RECEIPTS_BUCKET });

const RECEIPT_PATH_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{4}-\d{2}-\d{2})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$/;

/** `<staffId>/<workDate>/<uuid>.<ext>` — validated server-side against the
 *  session's own staff row, the security seam of every upload path here. */
export function isValidReceiptPath(path: string, staffId: string, workDate: string): boolean {
  const m = RECEIPT_PATH_RE.exec(path);
  return !!m && m[1] === staffId && m[2] === workDate;
}

const dayLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const gbp = (n: number): string => "£" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Email a receipt photo to accounts@ with the expense details. The bytes are
 * passed IN (already read while verifying the upload landed), so nothing can
 * fail before dispatchComm durably claims the communications row — every
 * later failure is a failed comm the retry worker re-drives. Returns true when
 * the pipeline accepted it (or an identical send already had); the caller
 * stamps `receipt_emailed_at` on that, so an unsent receipt stays visibly
 * unsent and the sweep below can pick it up.
 */
export async function emailReceiptToAccounts(input: {
  actorId: string | null;
  staffName: string;
  workDate: string;
  objectKey: string;
  imageBase64: string;
  expenseAmount: number | null;
  expenseNote: string | null;
}): Promise<boolean> {
  const day = dayLabel(input.workDate);
  const amount = input.expenseAmount != null && input.expenseAmount > 0 ? gbp(input.expenseAmount) : null;
  const note = input.expenseNote?.trim() || null;
  const subject = `Expense receipt — ${input.staffName} — ${day}${amount ? ` — ${amount}` : ""}`;
  const bodyText = [
    `${input.staffName} logged an expense receipt from the crew portal.`,
    `Date: ${day}`,
    amount ? `Amount: ${amount}` : `Amount: not entered yet — the weekly invoice carries the final figure.`,
    note ? `What it was: ${note}` : null,
    `The receipt photo is attached. The repayment will appear as an expense line on ${input.staffName}'s weekly invoice.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // The uuid in the attachment name keeps each upload's content hash unique,
  // so replacing a blurry photo can never be deduped away as a repeat send —
  // while a RE-send of the SAME photo dedupes to "already went", which is
  // exactly what lets the sweep below stamp a delivery it didn't perform.
  const attachmentName = `receipt-${input.objectKey.split("/").pop() ?? "photo.jpg"}`;

  const admin = createAdminClient();
  const res = await dispatchComm(admin, input.actorId, {
    channel: "email",
    to: opsAlertRecipient("money"),
    from: accountsFrom(),
    subject,
    bodyText,
    attachmentBase64: input.imageBase64,
    attachmentName,
  });
  if ("duplicate" in res) return true;
  return res.ok;
}

/**
 * Self-heal: re-send any receipt whose emailed stamp never landed — a claim
 * failure, a crash between send and stamp, or a delivery the retry worker
 * finished later. Rides the comms-retry cron. Content-hash dedupe makes a
 * re-send of an already-delivered receipt a no-op that just stamps, so this
 * can never double up the accounts@ inbox.
 */
export async function sweepUnemailedReceipts(
  sb: ReturnType<typeof createAdminClient>,
): Promise<{ receiptsSwept: number; receiptsStillUnsent: number }> {
  // 10 minutes' grace keeps the sweep off entries the user-facing action is
  // still working on; the cap bounds one tick's work (attachments are chunky).
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: rows, error } = await sb
    .from("staff_time_entries")
    .select("id, staff_id, work_date, receipt_key, expense_amount, expense_note, staff(full_name)")
    .not("receipt_key", "is", null)
    .is("receipt_emailed_at", null)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(`Receipt sweep read failed: ${error.message}`);

  let swept = 0;
  for (const row of rows ?? []) {
    if (!row.receipt_key) continue;
    let base64: string;
    try {
      const bytes = await receiptStore().getObject(row.receipt_key);
      base64 = Buffer.from(bytes).toString("base64");
    } catch {
      continue; // storage blip — next tick retries; the row stays visibly unsent
    }
    const staffName =
      (Array.isArray(row.staff) ? row.staff[0]?.full_name : (row.staff as { full_name: string } | null)?.full_name) ??
      "Crew member";
    const emailed = await emailReceiptToAccounts({
      actorId: null,
      staffName,
      workDate: row.work_date,
      objectKey: row.receipt_key,
      imageBase64: base64,
      expenseAmount: row.expense_amount == null ? null : Number(row.expense_amount),
      expenseNote: row.expense_note,
    });
    if (emailed) {
      // Stamp only if the receipt is still the one we just emailed.
      await sb
        .from("staff_time_entries")
        .update({ receipt_emailed_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("receipt_key", row.receipt_key);
      swept += 1;
    }
  }
  return { receiptsSwept: swept, receiptsStillUnsent: (rows?.length ?? 0) - swept };
}
