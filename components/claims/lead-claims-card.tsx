import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { ClaimStatusPill } from "@/components/claims/claim-status-pill";
import { OpenClaimDialog } from "@/components/claims/open-claim-dialog";
import { CLAIM_CHANNEL_LABEL, claimRef, type ClaimChannel, type ClaimStatus } from "@/lib/claims";
import { UK_TZ } from "@/lib/uk-time";

export interface LeadClaimRow {
  id: string;
  claimNo: number;
  status: ClaimStatus;
  reportedAt: string;
  reportedChannel: ClaimChannel;
  description: string;
}

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TZ,
  });

/** Claims on this enquiry + the manual open — shown once the job has a
 *  completion sign-off (a claim can follow a clean sign-off too). */
export function LeadClaimsCard({ leadId, claims }: { leadId: string; claims: LeadClaimRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="eyebrow">Claims</p>
          <p className="mt-0.5 text-xs text-mist-400">
            Damage or service claims on this job — the full register is on the Claims page.
          </p>
        </div>
        <OpenClaimDialog leadId={leadId} />
      </div>
      {claims.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-mist-400">
          <ShieldAlert className="size-4 shrink-0" strokeWidth={1.75} />
          No claims on this job.
        </p>
      ) : (
        <ul className="divide-y">
          {claims.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link
                href={`/claims/${c.id}`}
                className="focus-ring text-sm font-semibold text-foreground hover:underline"
              >
                {claimRef(c.claimNo)}
              </Link>
              <ClaimStatusPill status={c.status} />
              <span className="min-w-0 flex-1 truncate text-xs text-mist-400">
                {CLAIM_CHANNEL_LABEL[c.reportedChannel]} · {fmtAt(c.reportedAt)} · {c.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
