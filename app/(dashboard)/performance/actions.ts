"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Mark (or un-mark) an estimator's month as paid. Snapshots the visit count +
 * amount at settle time so the payout record stands even if data shifts later.
 * periodMonth is the first day of the month (YYYY-MM-01).
 */
export async function markEstimatorPaid(
  estimatorId: string,
  periodMonth: string,
  visits: number,
  amount: number,
  paid: boolean,
) {
  const sb = await createClient();
  const { error } = await sb.from("estimator_payouts").upsert(
    {
      estimator_id: estimatorId,
      period_month: periodMonth,
      visits,
      amount,
      paid_at: paid ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "estimator_id,period_month" },
  );
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/performance");
  return { ok: true as const };
}
