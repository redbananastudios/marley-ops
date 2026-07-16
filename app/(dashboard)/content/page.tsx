import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { loadJobMedia } from "@/lib/content/job-media-load";
import { JobMediaList } from "@/components/content/job-media-list";

/**
 * /content — the review queue for captured job content (PRD v1.0 §5).
 * Crew/estimators capture on jobs; everything lands here newest-first; the
 * office approves items before ANY marketing use (Peter's gate). Admin-client
 * data (signed URLs) → explicit office gate, same posture as /finance.
 */

export const dynamic = "force-dynamic";

const TABS = [
  { key: "needs-review", label: "Needs review" },
  { key: "approved", label: "Approved" },
  { key: "internal", label: "Internal only" },
  { key: "all", label: "All" },
] as const;

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const office = await requireOfficeProfile();
  if (!office) redirect("/");

  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "needs-review") as
    | "needs-review"
    | "approved"
    | "internal"
    | "all";

  const items = await loadJobMedia({ filter: tab === "all" ? undefined : tab, limit: 120 });

  return (
    <main className="flex-1 space-y-4 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Content">
        <p className="text-sm text-mist-400">
          Photos, video and voice notes captured on jobs. Approve the good ones — only approved
          content is ever used for marketing.
        </p>
      </PageHeader>

      <div className={segmentedTrackClass}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "needs-review" ? "/content" : `/content?tab=${t.key}`}
            className={segmentedItemClass(tab === t.key)}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <JobMediaList items={items} showJobLink />
      </Card>
    </main>
  );
}
