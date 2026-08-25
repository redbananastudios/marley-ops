import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Camera, FileDown, FileText, NotebookPen, PenLine, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET } from "@/lib/signatures";
import { listActiveBrands } from "@/lib/brand";
import { PageHeader } from "@/components/page-header";
import { BrandChip } from "@/components/brand/brand-chip";
import { Card } from "@/components/ui/card";
import { ClaimStatusPill } from "@/components/claims/claim-status-pill";
import { ClaimUpdateForm } from "@/components/claims/claim-update-form";
import { PrintSummaryButton } from "@/components/claims/print-summary-button";
import { requireOfficeProfile } from "@/lib/ai/auth";
import {
  CLAIM_CHANNEL_LABEL,
  CLAIM_RESOLUTION_LABEL,
  claimRef,
  daysOpen,
  isOpenClaimStatus,
  reportWindowEnd,
  type ClaimChannel,
  type ClaimResolution,
  type ClaimStatus,
} from "@/lib/claims";
import { UK_TZ } from "@/lib/uk-time";

/**
 * /claims/[id] — one claim, worked end to end: the report, the status trail,
 * the resolution + amount, and the EVIDENCE PACK an insurer asks for (signed
 * certificate, sign-off exceptions, crew notes/photos, captured job content,
 * the accepted quote's inventory, the signed contract). "Print summary" is the
 * exportable pack — controls are print-hidden so the page prints clean.
 */

export const dynamic = "force-dynamic";

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TZ,
  });

const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TZ,
  });

function EvidenceRow({
  icon: Icon,
  label,
  detail,
  href,
  hrefLabel,
}: {
  icon: typeof FileText;
  label: string;
  detail: string;
  href?: string | null;
  hrefLabel?: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-mist-500">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-mist-400">{detail}</p>
      </div>
      {href ? (
        <Link
          href={href}
          className="focus-ring shrink-0 rounded-sm text-xs font-medium text-mm-red hover:underline print:hidden"
        >
          {hrefLabel ?? "Open"}
        </Link>
      ) : null}
    </li>
  );
}

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const office = await requireOfficeProfile();
  if (!office) redirect("/");

  const { id } = await params;
  const sb = await createClient();
  const { data: claim } = await sb
    .from("claims")
    .select(
      "id, claim_no, lead_id, client_id, completion_id, status, reported_at, reported_channel, description, resolution, resolution_amount, insurer_ref, insurer_notified_at, notes, closed_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!claim) notFound();

  const [
    { data: lead },
    { data: completion },
    notesCount,
    mediaCount,
    { data: acceptedQuote },
    { data: contractSig },
    activeBrands,
  ] =
    await Promise.all([
      sb.from("leads").select("id, name, client_id, brand").eq("id", claim.lead_id).maybeSingle(),
      claim.completion_id
        ? sb
            .from("job_completions")
            .select("id, signed_at, crew_name, customer_name, customer_absent, exceptions, certificate_path")
            .eq("id", claim.completion_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      sb
        .from("job_notes")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", claim.lead_id)
        .then((r) => r.count ?? 0),
      sb
        .from("job_media")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", claim.lead_id)
        .then((r) => r.count ?? 0),
      sb
        .from("quotes")
        .select("id, quote_ref")
        .eq("lead_id", claim.lead_id)
        .eq("status", "accepted")
        .order("accepted_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb
        .from("signatures")
        .select("id, signer_name, channel, signed_at, quote_id")
        .eq("lead_id", claim.lead_id)
        .eq("kind", "contract")
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Brand layer (multi-brand PRD §4): the detail-page chip renders only in
      // multi-brand mode (the single-brand invariant, PRD §1).
      listActiveBrands(sb),
    ]);

  const chipBrand =
    activeBrands.length > 1 ? activeBrands.find((b) => b.slug === lead?.brand) : undefined;

  let certificateUrl: string | null = null;
  if (completion?.certificate_path) {
    certificateUrl = await createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET })
      .createSignedGetUrl(completion.certificate_path, 3600)
      .catch(() => null);
  }

  const ref = claimRef(claim.claim_no);
  const status = claim.status as ClaimStatus;
  const open = isOpenClaimStatus(status);
  const now = new Date();
  const windowEnd = completion?.signed_at ? reportWindowEnd(completion.signed_at) : null;
  const reportedInWindow = windowEnd ? Date.parse(claim.reported_at) <= windowEnd.getTime() : null;
  const amount = claim.resolution_amount != null ? Number(claim.resolution_amount) : null;

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader
        eyebrow="Customers"
        title={`Claim ${ref}`}
        backHref="/claims"
        backLabel="Claims"
        eyebrowAccessory={
          <>
            <ClaimStatusPill status={status} />
            {/* Detail-page eyebrows have room, so the chip carries the short
                name (multi-brand PRD §4 opening rules). */}
            {chipBrand ? <BrandChip brand={chipBrand} variant="eyebrow" /> : null}
          </>
        }
      >
        <PrintSummaryButton />
      </PageHeader>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="grid gap-5">
          <Card className="p-0">
            <div className="border-b px-5 py-3.5">
              <p className="eyebrow">The claim</p>
            </div>
            <div className="grid gap-3 px-5 py-4 text-sm">
              <p className="text-foreground">
                <span className="font-semibold">
                  {lead ? (
                    <Link href={`/leads/${lead.id}`} className="focus-ring hover:underline">
                      {lead.name ?? "Customer"}
                    </Link>
                  ) : (
                    "Customer"
                  )}
                </span>{" "}
                <span className="text-mist-400">
                  · reported via {CLAIM_CHANNEL_LABEL[claim.reported_channel as ClaimChannel].toLowerCase()} ·{" "}
                  {fmtAt(claim.reported_at)}
                  {open
                    ? ` · open ${daysOpen(claim.reported_at, now)} day${daysOpen(claim.reported_at, now) === 1 ? "" : "s"}`
                    : claim.closed_at
                      ? ` · closed ${fmtDay(claim.closed_at)}`
                      : ""}
                </span>
              </p>
              {windowEnd ? (
                <p
                  className={
                    "inline-flex w-fit items-center gap-1.5 rounded-pill px-2.5 py-1 text-[11px] font-semibold " +
                    (reportedInWindow ? "bg-success-bg text-success" : "bg-warn-bg text-warn")
                  }
                >
                  {reportedInWindow
                    ? `Reported within the 7-day T&Cs window (ended ${fmtDay(windowEnd.toISOString())})`
                    : `Reported after the 7-day T&Cs window (ended ${fmtDay(windowEnd.toISOString())})`}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap rounded-md bg-muted px-3.5 py-3 text-foreground">
                {claim.description}
              </p>
              {!open && claim.resolution ? (
                <p className="text-sm text-foreground">
                  Outcome:{" "}
                  <span className="font-semibold">
                    {CLAIM_RESOLUTION_LABEL[claim.resolution as ClaimResolution]}
                  </span>
                  {amount != null && amount > 0
                    ? ` · £${amount.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`
                    : ""}
                </p>
              ) : null}
              {claim.insurer_ref ? (
                <p className="text-xs text-mist-400">
                  Insurer ref: <span className="font-mono text-foreground">{claim.insurer_ref}</span>
                  {claim.insurer_notified_at ? ` · insurer notified ${fmtDay(claim.insurer_notified_at)}` : ""}
                </p>
              ) : claim.insurer_notified_at ? (
                <p className="text-xs text-mist-400">Insurer notified {fmtDay(claim.insurer_notified_at)}</p>
              ) : null}
              {claim.notes ? (
                <div className="hidden print:block">
                  <p className="eyebrow mb-1">Notes</p>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{claim.notes}</p>
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="p-0 print:hidden">
            <div className="border-b px-5 py-3.5">
              <p className="eyebrow">Manage</p>
              <p className="mt-0.5 text-xs text-mist-400">
                Every status change lands on the enquiry&apos;s timeline. Closing needs the outcome —
                goodwill payments need the amount.
              </p>
            </div>
            <div className="px-5 py-4">
              <ClaimUpdateForm
                claimId={claim.id}
                updatedAt={claim.updated_at}
                initial={{
                  status,
                  resolution: (claim.resolution ?? null) as ClaimResolution | null,
                  resolutionAmount: amount,
                  insurerRef: claim.insurer_ref ?? "",
                  insurerNotified: !!claim.insurer_notified_at,
                  notes: claim.notes ?? "",
                }}
              />
            </div>
          </Card>
        </div>

        <Card className="p-0">
          <div className="border-b px-4 py-3.5">
            <p className="eyebrow">Evidence pack</p>
            <p className="mt-0.5 text-xs text-mist-400">
              What an insurer asks for, gathered from the job&apos;s records.
            </p>
          </div>
          <ul className="divide-y">
            {completion ? (
              <EvidenceRow
                icon={ShieldCheck}
                label="Completion sign-off"
                detail={`${completion.customer_absent ? `Crew lead ${completion.crew_name} (customer not present)` : `Signed by ${completion.customer_name ?? "customer"} + crew lead ${completion.crew_name}`} · ${fmtAt(completion.signed_at)}${completion.exceptions?.trim() ? ` · exceptions: ${completion.exceptions.trim()}` : " · nothing reported"}`}
                href={lead ? `/leads/${lead.id}` : null}
                hrefLabel="Open enquiry"
              />
            ) : (
              <EvidenceRow
                icon={ShieldCheck}
                label="Completion sign-off"
                detail="No sign-off linked — the job may not have completed through the panel."
              />
            )}
            {certificateUrl ? (
              <li className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-mist-500">
                  <FileDown className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Completion certificate</p>
                  <p className="text-xs text-mist-400">The signed PDF, exactly as emailed to the customer.</p>
                </div>
                <a
                  href={certificateUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring shrink-0 rounded-sm text-xs font-medium text-mm-red hover:underline print:hidden"
                >
                  PDF
                </a>
              </li>
            ) : null}
            <EvidenceRow
              icon={PenLine}
              label="Signed contract"
              detail={
                contractSig
                  ? `Signed ${contractSig.channel === "in_person" ? "in person" : "online"} by ${contractSig.signer_name} · ${fmtAt(contractSig.signed_at)}`
                  : "No contract signature on this job."
              }
              href={contractSig?.quote_id ? `/quotes/${contractSig.quote_id}` : null}
              hrefLabel="Open quote"
            />
            <EvidenceRow
              icon={FileText}
              label="Accepted quote & inventory"
              detail={
                acceptedQuote
                  ? `${acceptedQuote.quote_ref} — the agreed spec and item list.`
                  : "No accepted quote on this enquiry."
              }
              href={acceptedQuote ? `/quotes/${acceptedQuote.id}` : null}
              hrefLabel="Open quote"
            />
            <EvidenceRow
              icon={NotebookPen}
              label="Crew notes & photos"
              detail={
                notesCount > 0
                  ? `${notesCount} note${notesCount === 1 ? "" : "s"} recorded on the job (damage, access, evidence photos).`
                  : "No crew notes on this job."
              }
              href={lead && notesCount > 0 ? `/leads/${lead.id}` : null}
              hrefLabel="Open enquiry"
            />
            <EvidenceRow
              icon={Camera}
              label="Captured job content"
              detail={
                mediaCount > 0
                  ? `${mediaCount} item${mediaCount === 1 ? "" : "s"} captured on the job (photos, video, voice notes).`
                  : "Nothing captured on this job."
              }
              href={lead && mediaCount > 0 ? `/leads/${lead.id}` : null}
              hrefLabel="Open enquiry"
            />
          </ul>
          <p className="border-t px-4 py-3 text-xs text-mist-400">
            Printing this page (or Save as PDF) produces the claim summary with the evidence list —
            attach the certificate PDF alongside it.
          </p>
        </Card>
      </div>
    </main>
  );
}
