"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import { hasSignedCurrentAgreement } from "@/lib/contractor/status";
import { round2 } from "@/lib/staff/statements";
import { UK_TZ, ukInstant } from "@/lib/uk-time";
import {
  buildEstimatorLines,
  jobVatApplies,
  type CompletedJob,
  type EstimatorFees,
  type PhoneQuote,
  type SurveyVisit,
} from "@/lib/estimator/invoice";

/**
 * Estimator contractor-invoicing actions (Luke). Estimators self-submit a weekly
 * invoice exactly like crew, reusing the staff_statements machinery anchored to
 * the estimator's OWN staff row — but the lines are the three fixed-fee events
 * (survey / phone_quote / commission), not hours. "Add my work" seeds them from
 * the week's attended surveys, telephone quotes and COMPLETED jobs. Commission is
 * earned on completion, so a cancelled job never seeds a commission line.
 */

const ESTIMATOR_SOURCES = ["survey", "phone_quote", "commission"] as const;
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
const UK = UK_TZ;

/** UK calendar day (YYYY-MM-DD) of a stored instant. */
const ukDay = (iso: string): string => new Date(iso).toLocaleDateString("en-CA", { timeZone: UK });

/** Precise [from, to) UTC window for a Mon–Sun UK period (DST-correct). */
function periodWindow(start: string, end: string): { fromIso: string; toIso: string } {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return { fromIso: ukInstant(sy, sm, sd).toISOString(), toIso: ukInstant(ey, em, ed + 1).toISOString() };
}

/**
 * Resolve the caller's own estimator context: an active staff row linked to their
 * login (so their invoice anchors to it), contractor invoicing switched on, and
 * their contractor agreement signed. Only estimators/admins self-invoice this way
 * — crew use /my-jobs/pay. Returns the estimator PROFILE id (for ownership) too.
 */
async function meAsEstimator() {
  const profile = await getSessionProfile();
  if (!profile) return { error: "Not signed in." as const };
  if (profile.role !== "estimator" && profile.role !== "admin") return { error: "Estimators only." as const };

  if (!(await isSelfBillingEnabled())) return { error: "Contractor invoicing isn't switched on yet." as const };

  const sb = await createClient();
  // Link by profile first; fall back to an email match and claim the row (mirrors
  // the crew first-login link) so a freshly-created estimator staff record works.
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
      .ilike("email", profile.email)
      .eq("is_active", true)
      .maybeSingle();
    if (byEmail) {
      await sb.from("staff").update({ profile_id: profile.id }).eq("id", byEmail.id);
      staffRow = byEmail;
    }
  }
  if (!staffRow) return { error: "Your login isn't linked to a staff record yet — ask the office to add you." as const };

  if (!(await hasSignedCurrentAgreement(sb, profile.id))) {
    return { error: "Sign your contractor agreement first." as const };
  }

  const settings = await getBusinessSettings(sb);
  const fees: EstimatorFees = {
    surveyFee: settings.estimatorFee,
    phoneQuoteFee: settings.estimatorPhoneQuoteFee,
    commissionPct: settings.estimatorCommissionPct,
  };
  return { sb, estimatorId: profile.id, staff: staffRow, fees };
}

/** Recompute an estimator statement's stored total from its lines (no guarantee
 *  floor — that is crew-only). */
async function recomputeEstimatorTotal(sb: Awaited<ReturnType<typeof createClient>>, statementId: string) {
  const { data: lines } = await sb.from("staff_statement_lines").select("amount").eq("statement_id", statementId);
  const total = round2((lines ?? []).reduce((s, l) => s + Number(l.amount ?? 0), 0));
  await sb.from("staff_statements").update({ total }).eq("id", statementId);
  return total;
}

const createSchema = z
  .object({ period_start: isoDate, period_end: isoDate })
  .refine((d) => d.period_end >= d.period_start, { message: "The period end can't be before the start.", path: ["period_end"] });

/** Start (or reuse) a draft invoice for a week. Reuses an open draft for the same
 *  period so an estimator never ends up with two half-filled invoices. */
export async function createMyEstimatorStatementAction(input: z.infer<typeof createSchema>) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await meAsEstimator();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, estimatorId, staff } = ctx;
  const { period_start, period_end } = parsed.data;

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
    return { ok: false as const, error: "You've already submitted an invoice for that week." };
  }

  const { data: refRow, error: refErr } = await sb.rpc("next_statement_ref");
  if (refErr || !refRow) return { ok: false as const, error: refErr?.message ?? "Could not allocate a reference." };

  const { data: created, error } = await sb
    .from("staff_statements")
    .insert({ staff_id: staff.id, ref: refRow as string, period_start, period_end, status: "draft", total: 0, created_by: estimatorId })
    .select("id")
    .single();
  if (error || !created) return { ok: false as const, error: error?.message ?? "Could not create the invoice." };

  revalidatePath("/estimator/pay");
  return { ok: true as const, id: created.id };
}

/**
 * Seed the week's estimator work into invoice lines: attended surveys (£50 each),
 * telephone quotes with no survey visit (£10 each, once per lead in the week it
 * was first quoted), and jobs that COMPLETED in the week (commission % of the
 * ex-VAT value). Replaces the computed lines only — hand-added manual lines stay.
 */
export async function seedMyEstimatorWorkAction(input: { statement_id: string }) {
  const id = z.string().uuid().safeParse(input.statement_id);
  if (!id.success) return { ok: false as const, error: "Invalid invoice." };
  const ctx = await meAsEstimator();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, estimatorId: me, staff, fees } = ctx;

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, staff_id, status, period_start, period_end")
    .eq("id", id.data)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Invoice not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This invoice has already been submitted." };

  const { fromIso, toIso } = periodWindow(stmt.period_start, stmt.period_end);
  const inWeek = (iso: string | null): boolean => !!iso && ukDay(iso) >= stmt.period_start && ukDay(iso) <= stmt.period_end;

  // ---- 1. Attended surveys (£50 each) — survey appts I attended, completed this week.
  const { data: myCompletedSurveys } = await sb
    .from("appointments")
    .select("id, lead_id, starts_at")
    .eq("appt_type", "survey")
    .eq("estimator_id", me)
    .eq("status", "completed")
    .gte("starts_at", fromIso)
    .lt("starts_at", toIso);
  const surveyRows = (myCompletedSurveys ?? []).filter((a) => a.starts_at && inWeek(a.starts_at));

  // ---- 2. Telephone quotes (£10 each) — quotes SENT this week, whose lead has NO
  //         survey visit and whose owner is me. One per lead, in the week it was
  //         FIRST quoted (so a later revision can't re-bill the £10).
  const { data: weekSentQuotes } = await sb
    .from("quotes")
    .select("lead_id")
    .not("email_sent_at", "is", null)
    .gte("email_sent_at", fromIso)
    .lt("email_sent_at", toIso);
  const phoneCandidateLeadIds = [...new Set((weekSentQuotes ?? []).map((q) => q.lead_id).filter(Boolean))] as string[];

  // ---- 3. Commission — jobs that COMPLETED this week (removal done + lead completed),
  //         owned by me, 7.5% of the accepted quote's ex-VAT value.
  const { data: weekRemovals } = await sb
    .from("appointments")
    .select("lead_id, starts_at")
    .eq("appt_type", "removal")
    .eq("status", "completed")
    .gte("starts_at", fromIso)
    .lt("starts_at", toIso);
  const completionByLead = new Map<string, string>(); // leadId -> latest UK move day in week
  for (const r of weekRemovals ?? []) {
    if (!r.lead_id || !r.starts_at || !inWeek(r.starts_at)) continue;
    const day = ukDay(r.starts_at);
    const cur = completionByLead.get(r.lead_id);
    if (!cur || day > cur) completionByLead.set(r.lead_id, day);
  }
  const completionLeadIds = [...completionByLead.keys()];

  // Batch the enrichment reads. Survey leads are folded in too so a survey line
  // always resolves the customer NAME (not "Customer") even when that lead had no
  // quote sent / job completed this week — this prints on a paid document.
  const surveyLeadIds = surveyRows.map((a) => a.lead_id).filter(Boolean) as string[];
  const allLeadIds = [...new Set([...surveyLeadIds, ...phoneCandidateLeadIds, ...completionLeadIds])];
  if (!allLeadIds.length && !surveyRows.length) {
    // Nothing to bill this week. Clear any previously-seeded computed lines (a
    // source may have been cancelled since a prior seed) and keep manual lines.
    await sb.from("staff_statement_lines").delete().eq("statement_id", stmt.id).in("source", [...ESTIMATOR_SOURCES]);
    await recomputeEstimatorTotal(sb, stmt.id);
    revalidatePath(`/estimator/pay/${stmt.id}`);
    return { ok: true as const, added: 0, warnings: [] as string[] };
  }

  const [{ data: leadRows }, { data: leadSurveyAppts }, { data: allQuotes }] = await Promise.all([
    allLeadIds.length
      ? sb.from("leads").select("id, name, status, estimator_id").in("id", allLeadIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; status: string; estimator_id: string | null }[] }),
    // Any non-cancelled survey appt marks a lead as a survey-visit lead (excluded
    // from phone quotes) and gives its earliest survey estimator (owner fallback).
    allLeadIds.length
      ? sb
          .from("appointments")
          .select("lead_id, estimator_id, starts_at")
          .eq("appt_type", "survey")
          .neq("status", "cancelled")
          .in("lead_id", allLeadIds)
          .order("starts_at", { ascending: true })
      : Promise.resolve({ data: [] as { lead_id: string | null; estimator_id: string | null; starts_at: string | null }[] }),
    allLeadIds.length
      ? sb
          .from("quotes")
          .select("lead_id, estimator_id, quote_ref, status, agreed_price, grand_total, vat_enabled, email_sent_at, accepted_at")
          .in("lead_id", allLeadIds)
      : Promise.resolve({ data: [] as { lead_id: string | null; estimator_id: string | null; quote_ref: string | null; status: string; agreed_price: number | null; grand_total: number | null; vat_enabled: boolean | null; email_sent_at: string | null; accepted_at: string | null }[] }),
  ]);

  const leadById = new Map((leadRows ?? []).map((l) => [l.id, l]));
  const leadsWithSurvey = new Set((leadSurveyAppts ?? []).map((a) => a.lead_id).filter(Boolean) as string[]);
  // Canonical owner fallback (lib/comms/sender.ts leadOwnerIdentity): the EARLIEST
  // survey that actually HAS an estimator — skip unassigned/null-estimator surveys,
  // else an empty earliest slot would mask the real surveyor.
  const earliestSurveyEstimator = new Map<string, string>();
  for (const a of leadSurveyAppts ?? []) {
    if (!a.lead_id || !a.estimator_id || earliestSurveyEstimator.has(a.lead_id)) continue; // ordered asc → first is earliest
    earliestSurveyEstimator.set(a.lead_id, a.estimator_id);
  }

  // ---- Cross-statement ledger: a fee is billed at most once EVER. Pull the keys
  //      already billed on this estimator's OTHER (non-void) statements so a job
  //      that spans a week boundary, or a re-quote in a later week, can't double-
  //      pay. Keyed: survey by appointment, phone/commission by lead; a lead that
  //      ever earned a survey fee never earns a phone fee (survey supersedes).
  const { data: priorStatements } = await sb
    .from("staff_statements")
    .select("id")
    .eq("staff_id", staff.id)
    .neq("status", "void")
    .neq("id", stmt.id);
  const priorIds = (priorStatements ?? []).map((s) => s.id);
  const billedSurveyApptIds = new Set<string>();
  const billedSurveyLeadIds = new Set<string>();
  const billedPhoneLeadIds = new Set<string>();
  const billedCommissionLeadIds = new Set<string>();
  if (priorIds.length) {
    const { data: priorLines } = await sb
      .from("staff_statement_lines")
      .select("source, appointment_id, lead_id")
      .in("statement_id", priorIds)
      .in("source", [...ESTIMATOR_SOURCES]);
    for (const l of priorLines ?? []) {
      if (l.source === "survey") {
        if (l.appointment_id) billedSurveyApptIds.add(l.appointment_id);
        if (l.lead_id) billedSurveyLeadIds.add(l.lead_id);
      } else if (l.source === "phone_quote") {
        if (l.lead_id) billedPhoneLeadIds.add(l.lead_id);
      } else if (l.source === "commission") {
        if (l.lead_id) billedCommissionLeadIds.add(l.lead_id);
      }
    }
  }

  // ---- Build the three input streams for the pure line builder.
  const surveys: SurveyVisit[] = surveyRows
    .filter((a) => !billedSurveyApptIds.has(a.id)) // this visit already invoiced on another statement
    .map((a) => ({
      apptId: a.id,
      leadId: a.lead_id,
      customer: (a.lead_id ? leadById.get(a.lead_id)?.name : null)?.trim() || "Customer",
      day: ukDay(a.starts_at as string),
    }));

  // Phone quotes: per candidate lead, the EARLIEST quote ever; count only if that
  // first send was this week, the lead has no survey visit, and I own it.
  const phoneQuotes: PhoneQuote[] = [];
  for (const leadId of phoneCandidateLeadIds) {
    if (leadsWithSurvey.has(leadId)) continue; // a survey lead is billed via the £50 path, never £10
    if (billedPhoneLeadIds.has(leadId)) continue; // already charged a phone fee for this lead
    if (billedSurveyLeadIds.has(leadId)) continue; // a prior survey fee supersedes any phone fee
    const lead = leadById.get(leadId);
    const quotes = (allQuotes ?? []).filter((q) => q.lead_id === leadId && q.email_sent_at);
    if (!quotes.length) continue;
    quotes.sort((a, b) => (a.email_sent_at ?? "").localeCompare(b.email_sent_at ?? ""));
    const first = quotes[0];
    if (!inWeek(first.email_sent_at)) continue; // first quoted in an earlier/later week → not this week's fee
    const owner = lead?.estimator_id ?? first.estimator_id ?? null;
    if (owner !== me) continue;
    phoneQuotes.push({
      leadId,
      ref: first.quote_ref,
      customer: lead?.name?.trim() || "Customer",
      day: ukDay(first.email_sent_at as string),
    });
  }

  // Commission: per completed job owned by me, from the accepted quote's value.
  // `warnings` surface jobs whose commission couldn't be computed so it's never
  // just silently missing off the invoice (the estimator would be short).
  const completions: CompletedJob[] = [];
  const warnings: string[] = [];
  for (const leadId of completionLeadIds) {
    if (billedCommissionLeadIds.has(leadId)) continue; // commission already billed for this job
    const lead = leadById.get(leadId);
    if (!lead || lead.status !== "completed") continue; // job truly done
    // Normally the supersede guard leaves exactly one accepted quote per lead.
    // If more than one survives, pick DETERMINISTICALLY the most-recently accepted
    // (the price the customer last committed to — matches /bookings + /performance),
    // tie-broken by quote_ref so the choice never varies run to run.
    const acceptedQuotes = (allQuotes ?? [])
      .filter((q) => q.lead_id === leadId && q.status === "accepted")
      .sort(
        (a, b) =>
          (b.accepted_at ?? "").localeCompare(a.accepted_at ?? "") ||
          (b.quote_ref ?? "").localeCompare(a.quote_ref ?? ""),
      );
    const accepted = acceptedQuotes[0];
    // Canonical owner: explicit lead estimator → earliest survey estimator → accepted quote estimator.
    const owner = lead.estimator_id ?? earliestSurveyEstimator.get(leadId) ?? accepted?.estimator_id ?? null;
    if (owner !== me) continue;
    if (!accepted) continue; // no accepted quote → no agreed value → nothing to commission

    const who = `${lead.name?.trim() || "a completed job"}${accepted.quote_ref ? ` (${accepted.quote_ref})` : ""}`;
    const completionDay = completionByLead.get(leadId) as string;
    const value = Number(accepted.agreed_price ?? accepted.grand_total ?? 0);
    // A completed job I own whose accepted quote has no agreed price can't be
    // commissioned. buildEstimatorLines would drop the resulting £0 line silently,
    // so surface it instead (unless commission is switched off entirely, pct=0).
    if (value <= 0) {
      if (fees.commissionPct > 0)
        warnings.push(`No commission added for ${who} — the accepted quote has no agreed price yet. Ask the office to set it, then re-add your work.`);
      continue;
    }
    if (acceptedQuotes.length > 1)
      warnings.push(`${who} has ${acceptedQuotes.length} accepted quotes — commission used the most recent. Ask the office to tidy the extras.`);

    completions.push({
      leadId,
      ref: accepted.quote_ref,
      customer: lead.name?.trim() || "Customer",
      day: completionDay,
      value,
      // Apply the VAT registration-date floor: a job billed before registration
      // carried no VAT even if the quote flag says otherwise (so ex-VAT = gross).
      vatEnabled: jobVatApplies(accepted.vat_enabled === true, completionDay),
    });
  }

  const lines = buildEstimatorLines({ surveys, phoneQuotes, completions, fees });

  // Replace the computed lines only; keep any hand-added manual lines.
  await sb.from("staff_statement_lines").delete().eq("statement_id", stmt.id).in("source", [...ESTIMATOR_SOURCES]);
  if (lines.length) {
    const { data: last } = await sb
      .from("staff_statement_lines")
      .select("sort_index")
      .eq("statement_id", stmt.id)
      .order("sort_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    let sort = (last?.sort_index ?? -1) + 1;
    const rows = lines.map((l) => ({
      statement_id: stmt.id,
      description: l.description,
      work_date: l.work_date,
      quantity: l.quantity,
      unit_amount: l.unit_amount,
      amount: l.amount,
      source: l.source,
      appointment_id: l.appointment_id,
      lead_id: l.lead_id,
      sort_index: sort++,
    }));
    const { error } = await sb.from("staff_statement_lines").insert(rows);
    if (error) return { ok: false as const, error: error.message };
  }
  await recomputeEstimatorTotal(sb, stmt.id);

  revalidatePath(`/estimator/pay/${stmt.id}`);
  return { ok: true as const, added: lines.length, warnings };
}

const lineSchema = z.object({
  id: z.string().uuid().optional(),
  statement_id: z.string().uuid(),
  description: z.string().trim().min(1, "Add a description").max(300),
  amount: z.coerce.number().positive("Enter an amount."),
});

/** Add or edit a hand-entered (manual) line — an agreed adjustment. The computed
 *  survey/phone/commission lines are policy-driven and not editable here. */
export async function upsertMyEstimatorLineAction(input: z.infer<typeof lineSchema>) {
  const parsed = lineSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await meAsEstimator();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff } = ctx;
  const l = parsed.data;

  const { data: stmt } = await sb.from("staff_statements").select("id, staff_id, status").eq("id", l.statement_id).maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Invoice not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This invoice has already been submitted." };

  // Computed lines are worked out from your surveys/quotes/jobs — not editable here.
  if (l.id) {
    const { data: existing } = await sb.from("staff_statement_lines").select("source").eq("id", l.id).maybeSingle();
    if (existing && existing.source !== "manual") return { ok: false as const, error: "That line is worked out automatically." };
  }

  const amount = round2(Math.max(0, l.amount));
  const row = { statement_id: l.statement_id, description: l.description, work_date: null, quantity: null, unit_amount: null, amount, source: "manual" as const };
  if (l.id) {
    const { error } = await sb.from("staff_statement_lines").update(row).eq("id", l.id);
    if (error) return { ok: false as const, error: error.message };
  } else {
    const { data: last } = await sb
      .from("staff_statement_lines")
      .select("sort_index")
      .eq("statement_id", l.statement_id)
      .order("sort_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { error } = await sb.from("staff_statement_lines").insert({ ...row, sort_index: (last?.sort_index ?? -1) + 1 });
    if (error) return { ok: false as const, error: error.message };
  }
  await recomputeEstimatorTotal(sb, l.statement_id);

  revalidatePath(`/estimator/pay/${l.statement_id}`);
  return { ok: true as const };
}

export async function deleteMyEstimatorLineAction(input: { id: string; statement_id: string }) {
  const p = z.object({ id: z.string().uuid(), statement_id: z.string().uuid() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await meAsEstimator();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff } = ctx;

  const { data: stmt } = await sb.from("staff_statements").select("id, staff_id, status").eq("id", p.data.statement_id).maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Invoice not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This invoice has already been submitted." };

  const { error } = await sb.from("staff_statement_lines").delete().eq("id", p.data.id).eq("statement_id", p.data.statement_id);
  if (error) return { ok: false as const, error: error.message };
  await recomputeEstimatorTotal(sb, p.data.statement_id);

  revalidatePath(`/estimator/pay/${p.data.statement_id}`);
  return { ok: true as const };
}

/** The estimator submits their own invoice — the generate + confirm step (the
 *  IR35-safe self-invoice). Locks it from further estimator edits. */
export async function submitMyEstimatorStatementAction(input: { statement_id: string; note?: string }) {
  const p = z.object({ statement_id: z.string().uuid(), note: z.string().trim().max(1000).optional() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await meAsEstimator();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb, staff } = ctx;

  const { data: stmt } = await sb.from("staff_statements").select("id, staff_id, status").eq("id", p.data.statement_id).maybeSingle();
  if (!stmt || stmt.staff_id !== staff.id) return { ok: false as const, error: "Invoice not found." };
  if (stmt.status !== "draft") return { ok: false as const, error: "This invoice has already been submitted." };

  const total = await recomputeEstimatorTotal(sb, stmt.id);
  const { count } = await sb.from("staff_statement_lines").select("id", { count: "exact", head: true }).eq("statement_id", stmt.id);
  if (!count) return { ok: false as const, error: "Add your work before submitting." };
  const { error } = await sb
    .from("staff_statements")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), note: p.data.note || null, total })
    .eq("id", stmt.id)
    .eq("status", "draft");
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/estimator/pay");
  revalidatePath(`/estimator/pay/${stmt.id}`);
  revalidatePath("/finance/statements");
  return { ok: true as const };
}
