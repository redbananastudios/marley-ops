import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RefreshButton } from "@/components/payments/refresh-button";
import { ReceivedTab, type ReceivedParams } from "./received-tab";

/**
 * Payments — the money surface. Received (what landed, by range, with the
 * rail), plus the admin-only Due and Upcoming views. Tab state lives in the
 * URL so every view is linkable.
 */

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<ReceivedParams & { tab?: string }>;
}) {
  const params = await searchParams;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { data: profile } = user
    ? await sb.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const isAdmin = profile?.role === "admin";
  void isAdmin; // Due/Upcoming tabs (admin-only) land with the next phase.

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Payments">
        <RefreshButton />
      </PageHeader>
      <ReceivedTab params={params} />
    </main>
  );
}
