import { redirect } from "next/navigation";
import { createDraftQuote } from "@/app/(dashboard)/quotes/actions";

/**
 * /quotes/new — create a fresh draft (optionally seeded from a lead) and bounce
 * straight to the builder. The draft exists in the panel from the first click,
 * so a half-finished quote is never lost.
 *
 * Next 16: searchParams is async.
 */
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const { leadId } = await searchParams;
  const res = await createDraftQuote({ leadId });
  if (!res.ok) {
    throw new Error(res.error || "Could not create a new quote");
  }
  redirect(`/quotes/${res.id}`);
}
