"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";

/** Office-only guard for crew-pay management (mark paid / void). RLS also backs
 *  this — a crew update USING requires status='draft', so a submitted/paid
 *  statement can never be mutated by a crew login. */
async function requireOffice() {
  const profile = await getSessionProfile();
  if (!profile) return { error: "Not signed in." as const };
  if (profile.role !== "admin" && profile.role !== "estimator") return { error: "Office only." as const };
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
  const ctx = await requireOffice();
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

/** Void a draft/submitted statement (e.g. raised in error). A paid statement is
 *  left alone — reverse the payment in the books first. */
export async function voidStatementAction(input: { id: string }) {
  const p = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: "Invalid input." };
  const ctx = await requireOffice();
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
