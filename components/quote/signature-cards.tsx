/* eslint-disable @next/next/no-img-element */
import { CheckCircle2, FileDown, PenLine, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { CONTRACT_ACKS } from "@/lib/signatures";

/**
 * Office view of the signed evidence (Peter, 2026-07-10: "we don't have
 * anywhere in the system to view these contracts"). Rendered on the quote
 * page: the contract signature (drawn image, or the typed name in the
 * signature script face) + the job-completion sign-off with its certificate.
 */

export interface ContractSignatureView {
  signer_name: string;
  signature_data: string | null;
  method: string;
  channel: string;
  acknowledgments: Record<string, unknown> | null;
  terms_version: string | null;
  signed_at: string;
}

export interface CompletionView {
  customer_name: string | null;
  customer_absent: boolean;
  absent_reason: string | null;
  exceptions: string;
  crew_name: string;
  signed_at: string;
  certificate_emailed_at: string | null;
  certificateUrl: string | null; // short-lived signed URL
}

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });

function SignatureImage({ sig }: { sig: ContractSignatureView }) {
  if (sig.signature_data) {
    return (
      <img
        src={sig.signature_data}
        alt={`Signature of ${sig.signer_name}`}
        className="h-16 max-w-60 rounded-md border border-border bg-white object-contain px-2"
      />
    );
  }
  // Older typed signatures without a stored image: write the name live.
  return (
    <div className="flex h-16 items-center rounded-md border border-border bg-white px-4">
      <span style={{ fontFamily: "'Signature Script', cursive", fontSize: 30, color: "#1F1D1B" }}>
        {sig.signer_name}
      </span>
    </div>
  );
}

export function ContractSignatureCard({
  signature,
  quoteStatus,
}: {
  signature: ContractSignatureView | null;
  quoteStatus: string;
}) {
  if (!signature && quoteStatus !== "accepted") return null;

  return (
    <Card className="gap-2 p-5">
      <p className="eyebrow flex items-center gap-1.5">
        <ShieldCheck className="size-3.5" strokeWidth={1.75} /> Contract
      </p>
      {!signature ? (
        <div className="rounded-md border border-warn-border bg-warn-bg px-3 py-2.5 text-sm font-medium text-warn">
          Accepted, but no customer signature yet — the crew are flagged to collect it on arrival.
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <SignatureImage sig={signature} />
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-foreground">{signature.signer_name}</p>
            <p className="text-mist-500">
              Signed {signature.channel === "in_person" ? "in person on the crew device" : "online"} ·{" "}
              {fmtAt(signature.signed_at)}
            </p>
            <p className="text-xs text-mist-400">Terms: {signature.terms_version ?? "—"}</p>
            <ul className="mt-1.5 space-y-0.5">
              {CONTRACT_ACKS.map((a) => {
                const ok = signature.acknowledgments?.[a.key] === true;
                return (
                  <li key={a.key} className="flex items-start gap-1.5 text-xs text-mist-500">
                    <CheckCircle2
                      className={`mt-0.5 size-3.5 shrink-0 ${ok ? "text-success" : "text-mist-300"}`}
                      strokeWidth={2}
                    />
                    {a.label}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

export function CompletionCard({ completion }: { completion: CompletionView | null }) {
  if (!completion) return null;
  return (
    <Card className="gap-2 p-5">
      <p className="eyebrow flex items-center gap-1.5">
        <PenLine className="size-3.5" strokeWidth={1.75} /> Job completion
      </p>
      <div className="text-sm">
        <p className="font-semibold text-foreground">
          {completion.customer_absent
            ? `Signed by crew lead ${completion.crew_name} — customer not present`
            : `Signed by ${completion.customer_name} and crew lead ${completion.crew_name}`}
        </p>
        <p className="text-mist-500">{fmtAt(completion.signed_at)}</p>
        {completion.customer_absent && completion.absent_reason ? (
          <p className="mt-1 text-xs text-mist-400">Reason: {completion.absent_reason}</p>
        ) : null}
        <p className={`mt-1.5 text-sm ${completion.exceptions ? "text-warn" : "text-success"}`}>
          {completion.exceptions ? `Exceptions: ${completion.exceptions}` : "Nothing to report."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {completion.certificateUrl ? (
            <a
              href={completion.certificateUrl}
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
            >
              <FileDown className="size-4" strokeWidth={1.75} />
              Completion certificate (PDF)
            </a>
          ) : null}
          <span className="text-xs text-mist-400">
            {completion.certificate_emailed_at
              ? `Emailed to the customer ${fmtAt(completion.certificate_emailed_at)}`
              : "Not emailed (no email on file or send failed)"}
          </span>
        </div>
      </div>
    </Card>
  );
}
