"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  computeLineAmount,
  seedLinesFromDays,
  guaranteeTopUp,
  round2,
  DEFAULT_DAY_HOURS,
  type SeedDay,
} from "@/lib/staff/statements";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import { hasSignedCurrentAgreement } from "@/lib/contractor/status";

const UK = "Europe/London";
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
const gbpShort = (n: number): string => "£" + Math.round(n).toLocaleString("en-GB");

/** Resolve the caller's own active staff row + their OWN pay (hourly rate +
 *  optional weekly guarantee) and confirm contractor invoicing is switched on.
 *  All crew pay writes go through here. RLS lets a crew member read only their
 *  own staff_pay row, so a colleague's rate is never exposed. */
async function meAsStaff() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "Not signed in." as const };

  if (!(await isSelfBillingEnabled())) return { error: "Contractor invoicing isn't switched on yet." as const };

  const { data: staffRow } = await sb
    .from("staff")
    .select("id, full_name")
    .eq("profile_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staffRow) return { error: "Your login isn’t linked to a crew record yet." as const };

  // Per-user gate: the contractor agreement must be signed before any invoicing.
  if (!(await hasSignedCurrentAgreement(sb, user.id))) {
    return { error: "Sign your contractor agreement first." as const };
  }

  const { data: pay } = await sb
    .from("staff_pay")
    .select("hourly_rate, weekly_guarantee")
    .eq("staff_id", staffRow.id)
    .maybeSingle();
  const hourlyRate = pay?.hourly_rate == null ? null : Number(pay.hourly_rate);
  const weeklyGuarantee = pay?.weekly_guarantee == null ? null : Number(pay.weekly_guarantee);

  return { sb, userId: user.id, staff: staffRow, hourlyRate, weeklyGuarantee };
}

/** Recompute a statement's stored total and reconcile the weekly-guarantee line.
 *  The total is the sum of line amounts (source of truth); for a guaranteed crew
 *  member a single 'guarantee' top-up line is (re)inserted so a light week
 *  reaches the floor and sum(lines) still equals total. Called after every line
 *  change. */
async function recomputeTotal(
  sb: Awaited<ReturnType<typeof createClient>>,
  statementId: string,
  weeklyGuarantee: number | null,
) {
  // Drop any prior top-up first — it is derived from the current lines.
  await sb.from("staff_statement_lines").delete().eq("statement_id", statementId).eq("source", "guarantee");
  const { data: lines } = await sb.from("staff_statement_lines").select("amount").eq("statement_id", statementId);
  const base = round2((lines ?? []).reduce((s, l) => s + Number(l.amount ?? 0), 0));

  const topUp = guaranteeTopUp(base, weeklyGuarantee);
  let total = base;
  if (topUp > 0 && weeklyGuarantee != null) {
    const { data: last } = await sb
      .from("staff_statement_lines")
      .select("sort_index")
      .eq("statement_id", statementId)
      .order("sort_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    await sb.from("staff_statement_lines").insert({
      statement_id: statementId,
      description: `Guaranteed weekly minimum (${gbpShort(weeklyGuarantee)})`,
      work_date: null,
      quantity: null,
      unit_amount: null,
      amount: topUp,
      source: "guarantee",
      sort_index: (last?.sort_index ?? -1) + 1,
    });
    total = round2(base + topUp);
  }

  await sb.from("staff_statements").update({ total }).eq("id", statementId);
  return total;
}

const createSchema = z.object({ period_start: isoDate, period_end: isoDate }).refine((d) => d.period_end >= d.period_start, {
  message: "The period end can’t be before the start.",
  path: ["period_end"],
});

/** Start (or reuse) a draft statement for a pay period. Reuses an existing draft
 *  for the same period so a crew member never ends up with two half-filled ones. */
export async function createMyStatementAction(input: z.infer<typeof createSchema>) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await meAsStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, userId, staff } = ctx;
  const { period_start, period_end } = parsed.data;

  // One live statement per period (0057 backs this at the DB). Reuse an existing
  // draft; refuse if the week was already submitted/paid so it can't be double-paid.
  const { data: existing } = await sb
    .from("staff_statements")
    .select("id, status")
    .eq("staff_id", staff.id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .neq("status", "void")
    .maybeSingle();
  if (existing) {
    if (existing.status === "draft") return { ok: true as const, id: existing.id };
    return { ok: false as const, error: "You've already submitted a statement for that week." };
  }

  const { data: refRow, error: refErr } = await sb.rpc("next_statement_ref");
  if (refErr || !refRow) return { ok: false as const, error: refErr?.message ?? "Could not allocate a reference." };

  const { data: created, error } = await sb
    .from("staff_statements")
    .insert({ staff_id: staff.id, ref: refRow as string, period_start, period_end, status: "draft", total: 0, created_by: userId })
    .select("id")
    .single();
  if (error || !created) return { ok: false as const, error: error?.message ?? "Could not create the statement." };

  revalidatePath("/my-jobs/pay");
  return { ok: true as const, id: created.id };
}

/** Pull the crew member's assigned jobs in the period into suggested lines — one
 *  per DAY at their day rate. Re-seeding replaces the previous job lines only;
 *  hand-added lines (retainer, extras) are left untouched. */
export async function seedMyStatementJobsAction(input: { statement_id: string }) {
  const id = z.string().uuid().safeParse(input.statement_id);
  if (!id.success) return { ok: false as const, error: "Invalid statement." };
  const ctx = await meAsStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff, hourlyRate, weeklyGuarantee } = ctx;

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, staff_id, status, period_start, period_end")
    .eq("id", id.data)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Statement not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This statement has already been submitted." };

  // The crew member's assigned appointments that fall in the period.
  const { data: myAssigns } = await sb.from("appointment_assignments").select("appointment_id").eq("staff_id", staff.id);
  const apptIds = [...new Set((myAssigns ?? []).map((a) => a.appointment_id))];
  const days: SeedDay[] = [];
  if (apptIds.length) {
    const { data: appts } = await sb
      .from("appointments")
      .select("id, starts_at, appt_type, lead_id, status")
      .in("id", apptIds)
      .neq("status", "cancelled");
    const leadIds = [...new Set((appts ?? []).map((a) => a.lead_id).filter(Boolean))] as string[];
    const { data: leads } = leadIds.length
      ? await sb.from("leads").select("id, name").in("id", leadIds)
      : { data: [] as { id: string; name: string | null }[] };
    const leadName = new Map((leads ?? []).map((l) => [l.id, l.name]));

    const byDay = new Map<string, string[]>();
    for (const a of appts ?? []) {
      if (!a.starts_at) continue;
      const day = new Date(a.starts_at).toLocaleDateString("en-CA", { timeZone: UK });
      if (day < stmt.period_start || day > stmt.period_end) continue;
      const who = (a.lead_id ? leadName.get(a.lead_id) : null) ?? "job";
      const label = `${a.appt_type === "removal" ? "Move" : "Survey"} — ${who}`;
      const list = byDay.get(day) ?? [];
      list.push(label);
      byDay.set(day, list);
    }
    for (const [day, labels] of byDay) {
      days.push({ date: day, label: labels.length > 1 ? `${labels[0]} (+${labels.length - 1} more)` : labels[0] });
    }
  }

  if (!days.length) return { ok: false as const, error: "No assigned jobs found in this period." };

  // Replace previous job-seeded lines only. Seeded at the standard day length ×
  // the crew member's hourly rate; they then edit the actual hours per line.
  await sb.from("staff_statement_lines").delete().eq("statement_id", stmt.id).eq("source", "job");
  const rows = seedLinesFromDays(days, hourlyRate, DEFAULT_DAY_HOURS).map((l, i) => ({
    statement_id: stmt.id,
    description: l.description,
    work_date: l.work_date,
    quantity: l.quantity,
    unit_amount: l.unit_amount,
    amount: l.amount,
    source: l.source,
    sort_index: i,
  }));
  const { error } = await sb.from("staff_statement_lines").insert(rows);
  if (error) return { ok: false as const, error: error.message };
  await recomputeTotal(sb, stmt.id, weeklyGuarantee);

  revalidatePath(`/my-jobs/pay/${stmt.id}`);
  return { ok: true as const, added: rows.length };
}

const lineSchema = z.object({
  id: z.string().uuid().optional(),
  statement_id: z.string().uuid(),
  description: z.string().trim().min(1, "Add a description").max(300),
  work_date: z.union([z.literal(""), isoDate]).optional(),
  quantity: z.union([z.literal(""), z.coerce.number().nonnegative()]).optional(),
  unit_amount: z.union([z.literal(""), z.coerce.number().nonnegative()]).optional(),
  amount: z.union([z.literal(""), z.coerce.number().nonnegative()]).optional(),
});

/** Add or edit ONE statement line (the free-description ledger). Amount is
 *  recomputed server-side (quantity × rate, else the entered amount). */
export async function upsertMyStatementLineAction(input: z.infer<typeof lineSchema>) {
  const parsed = lineSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await meAsStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff, weeklyGuarantee } = ctx;
  const l = parsed.data;

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, staff_id, status")
    .eq("id", l.statement_id)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Statement not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This statement has already been submitted." };

  // The weekly-guarantee top-up is system-managed — a crew member can't edit it
  // into a different figure (recomputeTotal owns it).
  if (l.id) {
    const { data: existing } = await sb.from("staff_statement_lines").select("source").eq("id", l.id).maybeSingle();
    if (existing?.source === "guarantee") return { ok: false as const, error: "That line is worked out automatically." };
  }

  const qty = l.quantity === "" || l.quantity == null ? null : Number(l.quantity);
  const unit = l.unit_amount === "" || l.unit_amount == null ? null : Number(l.unit_amount);
  const enteredAmount = l.amount === "" || l.amount == null ? null : Number(l.amount);
  const amount = computeLineAmount(qty, unit, enteredAmount);

  const row = {
    statement_id: l.statement_id,
    description: l.description,
    work_date: l.work_date || null,
    quantity: qty,
    unit_amount: unit,
    amount,
    source: "manual" as const,
  };
  if (l.id) {
    const { error } = await sb.from("staff_statement_lines").update(row).eq("id", l.id);
    if (error) return { ok: false as const, error: error.message };
  } else {
    // Append after existing (incl. seeded) lines so re-seeding never shuffles order.
    const { data: last } = await sb
      .from("staff_statement_lines")
      .select("sort_index")
      .eq("statement_id", l.statement_id)
      .order("sort_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { error } = await sb
      .from("staff_statement_lines")
      .insert({ ...row, sort_index: (last?.sort_index ?? -1) + 1 });
    if (error) return { ok: false as const, error: error.message };
  }
  await recomputeTotal(sb, l.statement_id, weeklyGuarantee);

  revalidatePath(`/my-jobs/pay/${l.statement_id}`);
  return { ok: true as const };
}

export async function deleteMyStatementLineAction(input: { id: string; statement_id: string }) {
  const p = z.object({ id: z.string().uuid(), statement_id: z.string().uuid() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await meAsStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff, weeklyGuarantee } = ctx;

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, staff_id, status")
    .eq("id", p.data.statement_id)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Statement not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This statement has already been submitted." };

  // Don't let a crew member delete the system-managed guarantee top-up directly —
  // it's reconciled from the other lines by recomputeTotal.
  const { data: target } = await sb.from("staff_statement_lines").select("source").eq("id", p.data.id).maybeSingle();
  if (target?.source === "guarantee") return { ok: false as const, error: "That line is worked out automatically." };

  const { error } = await sb.from("staff_statement_lines").delete().eq("id", p.data.id).eq("statement_id", p.data.statement_id);
  if (error) return { ok: false as const, error: error.message };
  await recomputeTotal(sb, p.data.statement_id, weeklyGuarantee);

  revalidatePath(`/my-jobs/pay/${p.data.statement_id}`);
  return { ok: true as const };
}

/** The crew member submits their own statement — the "generate + confirm" step
 *  that is both the timesheet and the IR35 self-billing action. Locks it from
 *  further crew edits (RLS: USING(draft) fails once status != draft). */
export async function submitMyStatementAction(input: { statement_id: string; note?: string }) {
  const p = z.object({ statement_id: z.string().uuid(), note: z.string().trim().max(1000).optional() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await meAsStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff, weeklyGuarantee } = ctx;

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, staff_id, status")
    .eq("id", p.data.statement_id)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Statement not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This statement has already been submitted." };

  // Recompute FIRST so a guaranteed crew member's minimum top-up line exists
  // before the "at least one line" check — a guaranteed week with genuinely no
  // work (Rob is paid whether there's work or not) is still a valid £-minimum
  // invoice carrying just the guarantee line.
  const total = await recomputeTotal(sb, stmt.id, weeklyGuarantee);
  const { count } = await sb
    .from("staff_statement_lines")
    .select("id", { count: "exact", head: true })
    .eq("statement_id", stmt.id);
  if (!count) return { ok: false as const, error: "Add at least one line before submitting." };
  // .eq('status','draft') makes the transition idempotent — a double-tap can't
  // move an already-submitted statement, and RLS blocks a non-draft crew update.
  const { error } = await sb
    .from("staff_statements")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), note: p.data.note || null, total })
    .eq("id", stmt.id)
    .eq("status", "draft");
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/my-jobs/pay");
  revalidatePath(`/my-jobs/pay/${stmt.id}`);
  revalidatePath("/finance/statements");
  return { ok: true as const };
}
