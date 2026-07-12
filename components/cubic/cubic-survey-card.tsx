import Link from "next/link";
import { Boxes, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { CopyCubicLinkButton } from "@/components/cubic/copy-cubic-link-button";

/**
 * Cubic survey card for the quote surfaces (Peter, 2026-07-11: the volume
 * survey is a quote-time activity — access it from the quote form + View
 * Quote, not the leads page). Mirrors iMVE's "Cubic Sheet Details" card: open
 * the survey, or copy the customer self-fill link. The survey data stays
 * lead-anchored (one per lead, reused across quote revisions), so the entry
 * points here only need the lead id.
 */

export interface CubicCardData {
  rawFt3: number;
  planningFt3: number;
  contingencyPct: number;
  guidanceReady: boolean;
  vanLabel: string | null;
  itemCount: number;
  status: string; // draft | complete | customer_submitted | (none)
  hasSurvey: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "In progress",
  complete: "Complete",
  customer_submitted: "Sent by the customer",
};

export function CubicSurveyCard({ leadId, data }: { leadId: string; data: CubicCardData | null }) {
  const has = data?.hasSurvey && data.rawFt3 > 0;
  return (
    <Card className="gap-3 p-5">
      <p className="eyebrow flex items-center gap-1.5">
        <Boxes className="size-3.5" strokeWidth={1.75} /> Cubic survey
      </p>

      {has ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="tabular font-display text-2xl font-bold text-foreground">
            {data!.rawFt3.toLocaleString("en-GB")} ft³ raw
          </span>
          {data!.guidanceReady && data!.contingencyPct > 0 ? <span className="text-sm font-semibold text-amber-800">+{data!.contingencyPct}% · {data!.planningFt3.toLocaleString("en-GB")} ft³ planning</span> : null}
          {data!.vanLabel ? (
            <span className="rounded-pill bg-mm-red-tint px-2.5 py-0.5 text-xs font-semibold text-mm-red-deep">
              ≈ {data!.vanLabel}
            </span>
          ) : null}
          <span className="text-xs text-mist-400">
            {data!.itemCount} item{data!.itemCount === 1 ? "" : "s"}
            {STATUS_LABEL[data!.status] ? ` · ${STATUS_LABEL[data!.status]}` : ""}
          </span>
          {!data!.guidanceReady ? <span className="w-full text-xs font-semibold text-amber-800">Complete every AI room before using vehicle guidance.</span> : null}
        </div>
      ) : (
        <p className="text-sm text-mist-500">
          Itemise what&apos;s moving to get the volume and the van count — done on a tablet at the survey, or send the
          customer a link to fill it in themselves.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/leads/${leadId}/cubic`}
          className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep"
        >
          <Boxes className="size-4" strokeWidth={2} />
          {has ? "Open cubic survey" : "Start cubic survey"}
          <ChevronRight className="size-4" strokeWidth={2} />
        </Link>
        <CopyCubicLinkButton leadId={leadId} />
      </div>
    </Card>
  );
}
