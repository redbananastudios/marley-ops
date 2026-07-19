"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";

/** ADMIN-only guard for contractor-pay management (mark paid / void / return).
 *  Releasing money — and reviewing every contractor's pay — is an owner action:
 *  estimators are `is_office()` but must NOT be able to pay (or see) their own or
 *  a colleague's invoice, so this is tighter than the office gate. RLS also backs
 *  the draft-only crew edits; this locks the money transitions to admins. */
async function requireAdmin() {
  const profile = await getSessionProfile();
  if (!profile) return { error: "Not signed in." as const };
  if (profile.role !== "admin") return { error: "Owner only." as const };
  const sb = await createClient();
  return { sb };
}

const paidSchema = z.object({
  id: z.string().uuid(),
  method: z.enum(["bacs", "cash", "other"]),
  ref: z.string().trim().max(120).optional().or(z.literal("")),
});

/** Mark a SUBMITTED statement paid. The `.eq('status','submitted')` makes it
 *  idempotent — a double-tap can't re-pay, and a draft/void one won't flip. */
export async function markStatementPaidAction(input: z.infer<typeof paidSchema>) {
  const parsed = paidSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await requireAdmin();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;
  const a = parsed.data;

  const { data, error } = await sb
    .from("staff_statements")
    .update({ status: "paid", paid_at: new Date().toISOString(), paid_method: a.method, paid_ref: a.ref || null })
    .eq("id", a.id)
    .eq("status", "submitted")
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!data?.length) return { ok: false as const, error: "Only a submitted statement can be marked paid." };

  revalidatePath("/finance/statements");
  return { ok: true as const };
}

const returnSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1, "Give a reason for the change.").max(500),
});

/** Return a SUBMITTED statement to the crew for changes, with a reason. Self-
 *  billing hinges on the crew generating + CONFIRMING their own pay (the IR35
 *  mitigation), so the office never silently rewrites a submitted statement — it
 *  hands it back as a draft and the crew fix + re-submit. The `.eq('submitted')`
 *  guard keeps it idempotent; clearing submitted_at makes it read as a fresh
 *  draft again. RLS already permits the office update. */
export async function returnStatementToCrewAction(input: z.infer<typeof returnSchema>) {
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const ctx = await requireAdmin();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;
  const a = parsed.data;

  const { data, error } = await sb
    .from("staff_statements")
    .update({ status: "draft", return_reason: a.reason, returned_at: new Date().toISOString(), submitted_at: null })
    .eq("id", a.id)
    .eq("status", "submitted")
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!data?.length) return { ok: false as const, error: "Only a submitted statement can be returned." };

  revalidatePath("/finance/statements");
  revalidatePath("/my-jobs/pay");
  revalidatePath(`/my-jobs/pay/${a.id}`);
  // Estimator invoices ride the same table — refresh their surface too.
  revalidatePath("/estimator/pay");
  revalidatePath(`/estimator/pay/${a.id}`);
  return { ok: true as const };
}

/** Void a draft/submitted statement (e.g. raised in error). A paid statement is
 *  left alone — reverse the payment in the books first. */
export async function voidStatementAction(input: { id: string }) {
  const p = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await requireAdmin();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const { sb } = ctx;

  const { data, error } = await sb
    .from("staff_statements")
    .update({ status: "void" })
    .eq("id", p.data.id)
    .in("status", ["draft", "submitted"])
    .select("id");
  if (error) return { ok: false as const, error: error.message };
  if (!data?.length) return { ok: false as const, error: "A paid statement can't be voided — reverse the payment first." };

  revalidatePath("/finance/statements");
  return { ok: true as const };
}
