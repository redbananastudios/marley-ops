import Link from "next/link";
import { FileDown, FileText, PenLine, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_DOCS_BUCKET } from "@/lib/signatures";
import { PageHeader } from "@/components/page-header";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { UK_TZ } from "@/lib/uk-time";

/**
 * /documents — the business's paperwork file (final-pass audit, 2026-07-10).
 * One register of every signed document: contract signatures, completion
 * certificates, and (with billing phase 2) storage agreements. Answers the
 * recall moments a removals firm actually has — a damage claim a year later,
 * an insurer asking for the signed contract, "which of the booked jobs still
 * has no signature?" — by name search or by date, one tap on iPad.
 *
 * The in-context cards on /quotes/[id] stay; this is the cross-customer view.
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

const fmtDay = (d: string | null): string =>
  d
    ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

type DocRow = {
  key: string;
  kind: "contract" | "storage" | "completion";
  signedAt: string;
  customer: string;
  clientId: string | null;
  leadId: string | null;
  quoteId: string | null;
  quoteRef: string | null;
  detail: string;
  exceptions: string | null;
  certificateUrl: string | null;
};

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const tab =
    sp.tab === "unsigned" ? "unsigned" : sp.tab === "contractors" ? "contractors" : "all";
  const sb = await createClient();

  // Contractor agreements (office reads all via RLS) — filed here as the
  // record that each self-employed worker signed their one-time agreement.
  const { data: agreements } = await sb
    .from("contractor_agreements")
    .select("id, signer_name, role, agreement_version, signed_at")
    .order("signed_at", { ascending: false })
    .limit(400);
  const agreementRows = (agreements ?? []).filter(
    (a) => !q || a.signer_name.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q),
  );

  const [{ data: sigs }, { data: comps }, { data: acceptedQuotes }] = await Promise.all([
    sb
      .from("signatures")
      .select("id, kind, quote_id, lead_id, client_id, signer_name, method, channel, signed_at")
      .order("signed_at", { ascending: false })
      .limit(400),
    sb
      .from("job_completions")
      .select(
        "id, lead_id, client_id, customer_name, customer_absent, exceptions, crew_name, signed_at, certificate_path",
      )
      .order("signed_at", { ascending: false })
      .limit(400),
    sb
      .from("quotes")
      .select("id, quote_ref, customer_name, lead_id, client_id, moving_date, deposit_paid_at, status")
      .eq("status", "accepted")
      .order("moving_date", { ascending: true, nullsFirst: false })
      .limit(400),
  ]);

  // Name lookups for rows whose display name isn't denormalised.
  const leadIds = [
    ...new Set(
      [...(sigs ?? []), ...(comps ?? [])].map((r) => r.lead_id).filter(Boolean) as string[],
    ),
  ];
  const quoteIds = [...new Set((sigs ?? []).map((s) => s.quote_id).filter(Boolean) as string[])];
  const [{ data: leadRows }, { data: quoteRows }] = await Promise.all([
    leadIds.length
      ? sb.from("leads").select("id, name").in("id", leadIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
    quoteIds.length
      ? sb.from("quotes").select("id, quote_ref, customer_name").in("id", quoteIds)
      : Promise.resolve({ data: [] as { id: string; quote_ref: string; customer_name: string | null }[] }),
  ]);
  const leadName = new Map((leadRows ?? []).map((l) => [l.id, l.name]));
  const quoteById = new Map((quoteRows ?? []).map((qr) => [qr.id, qr]));

  // Certificate links (short-lived) in one batch.
  const certPaths = (comps ?? []).map((c) => c.certificate_path).filter(Boolean) as string[];
  const certUrl = new Map<string, string>();
  if (certPaths.length) {
    const store = createMediaStore(process.env, { bucket: JOB_DOCS_BUCKET });
    const signed = await Promise.all(
      certPaths.map((path) =>
        store.createSignedGetUrl(path, 3600).then(
          (url) => [path, url] as const,
          () => null, // drop any path whose sign fails, as before
        ),
      ),
    );
    for (const s of signed) if (s) certUrl.set(s[0], s[1]);
  }

  const rows: DocRow[] = [
    ...(sigs ?? []).map((s): DocRow => {
      const qr = s.quote_id ? quoteById.get(s.quote_id) : null;
      return {
        key: `s-${s.id}`,
        kind: (s.kind === "storage" ? "storage" : "contract") as DocRow["kind"],
        signedAt: s.signed_at,
        customer: qr?.customer_name || (s.lead_id ? leadName.get(s.lead_id) : null) || s.signer_name,
        clientId: s.client_id,
        leadId: s.lead_id,
        quoteId: s.quote_id,
        quoteRef: qr?.quote_ref ?? null,
        detail: `Signed ${s.channel === "in_person" ? "in person" : "online"} by ${s.signer_name}`,
        exceptions: null,
        certificateUrl: null,
      };
    }),
    ...(comps ?? []).map(
      (c): DocRow => ({
        key: `c-${c.id}`,
        kind: "completion",
        signedAt: c.signed_at,
        customer: c.customer_name || (c.lead_id ? leadName.get(c.lead_id) : null) || "Customer",
        clientId: c.client_id,
        leadId: c.lead_id,
        quoteId: null,
        quoteRef: null,
        detail: c.customer_absent
          ? `Crew lead ${c.crew_name} (customer not present)`
          : `Customer + crew lead ${c.crew_name}`,
        exceptions: c.exceptions?.trim() || null,
        certificateUrl: c.certificate_path ? (certUrl.get(c.certificate_path) ?? null) : null,
      }),
    ),
  ]
    .sort((a, b) => (a.signedAt < b.signedAt ? 1 : -1))
    .filter(
      (r) =>
        !q ||
        r.customer.toLowerCase().includes(q) ||
        (r.quoteRef ?? "").toLowerCase().includes(q) ||
        r.detail.toLowerCase().includes(q),
    );

  // Unsigned tab: accepted quotes with no contract signature, soonest move first.
  const signedQuoteIds = new Set((sigs ?? []).map((s) => s.quote_id).filter(Boolean));
  const unsigned = (acceptedQuotes ?? [])
    .filter((aq) => !signedQuoteIds.has(aq.id))
    .filter((aq) => !q || (aq.customer_name ?? "").toLowerCase().includes(q) || aq.quote_ref.toLowerCase().includes(q));

  const KIND_META: Record<DocRow["kind"], { label: string; cls: string }> = {
    contract: { label: "Contract", cls: "border border-mm-red/45 bg-card text-mm-red-deep" },
    storage: { label: "Storage agreement", cls: "bg-muted text-mist-500" },
    completion: { label: "Completion certificate", cls: "bg-success-bg text-success" },
  };

  const tabLink = (t: string) => `/documents?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(t !== "all" ? { tab: t } : {}) })}`;

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Documents" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className={segmentedTrackClass}>
          {(
            [
              ["all", `All documents (${rows.length})`],
              ["unsigned", `Unsigned contracts (${unsigned.length})`],
              ["contractors", `Contractor agreements (${agreementRows.length})`],
            ] as const
          ).map(([t, label]) => (
            <Link key={t} href={tabLink(t)} aria-current={tab === t ? "page" : undefined} className={segmentedItemClass(tab === t)}>
              {label}
            </Link>
          ))}
        </div>
        <form method="GET" className="flex items-center gap-2">
          {tab !== "all" ? <input type="hidden" name="tab" value={tab} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search name or quote ref…"
            className="focus-ring h-10 w-64 rounded-md border border-input bg-card px-3 text-sm"
          />
        </form>
      </div>

      {tab === "unsigned" ? (
        <Card className="p-0">
          {unsigned.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={q ? "No unsigned contracts match" : "All contracts signed"}
              hint={
                q
                  ? "Try a different search, or clear it."
                  : "Accepted quotes with no signature show here — the crew collect it on arrival."
              }
            />
          ) : (
            <ul className="divide-y">
              {unsigned.map((aq) => (
                <li key={aq.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <Link href={`/quotes/${aq.id}`} className="focus-ring text-sm font-semibold text-foreground hover:underline">
                      {aq.customer_name ?? "Customer"}
                    </Link>
                    <p className="text-xs text-mist-400">
                      {aq.quote_ref} · moving {fmtDay(aq.moving_date)} ·{" "}
                      {aq.deposit_paid_at ? "deposit paid" : "deposit awaiting"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-pill border border-warn-border bg-warn-bg px-2.5 py-1 text-[11px] font-semibold text-warn">
                      <PenLine className="size-3.5" strokeWidth={2} />
                      Signature needed — crew collect on arrival
                    </span>
                    <Link
                      href={`/quotes/${aq.id}`}
                      className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <FileText className="size-3.5" strokeWidth={1.75} />
                      Open quote
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : tab === "contractors" ? (
        <Card className="p-0">
          {agreementRows.length === 0 ? (
            <EmptyState
              icon={PenLine}
              title={q ? "No agreements match" : "No contractor agreements yet"}
              hint={
                q
                  ? "Try a different search, or clear it."
                  : "When a crew member or estimator signs their one-time contractor agreement, it's filed here."
              }
            />
          ) : (
            <ul className="divide-y">
              {agreementRows.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <span className="shrink-0 rounded-pill border border-mm-red/45 bg-card px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-mm-red-deep">
                    Contractor agreement
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{a.signer_name}</p>
                    <p className="text-xs text-mist-400">
                      {a.role === "estimator" ? "Estimator" : a.role === "crew" ? "Crew" : a.role} · version{" "}
                      {a.agreement_version} · signed {fmtAt(a.signed_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={q ? "No documents match" : "No documents yet"}
              hint={
                q
                  ? "Try a different search, or clear it."
                  : "Signed contracts and completion certificates appear here as they're collected."
              }
            />
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <span className={`shrink-0 rounded-pill px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${KIND_META[r.kind].cls}`}>
                    {KIND_META[r.kind].label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">
                      {r.clientId ? (
                        <Link href={`/clients/${r.clientId}`} className="focus-ring hover:underline">
                          {r.customer}
                        </Link>
                      ) : (
                        r.customer
                      )}
                      {r.quoteRef && r.quoteId ? (
                        <>
                          {" "}
                          <Link href={`/quotes/${r.quoteId}`} className="focus-ring text-xs font-medium text-mist-400 hover:underline">
                            {r.quoteRef}
                          </Link>
                        </>
                      ) : null}
                    </p>
                    <p className="text-xs text-mist-400">
                      {r.detail} · {fmtAt(r.signedAt)}
                      {r.leadId ? (
                        <>
                          {" · "}
                          <Link href={`/leads/${r.leadId}`} className="focus-ring hover:underline">
                            open enquiry
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  {r.kind === "completion" ? (
                    <span
                      className={
                        "shrink-0 rounded-pill px-2 py-0.5 text-[11px] font-semibold " +
                        (r.exceptions ? "bg-warn-bg text-warn" : "bg-success-bg text-success")
                      }
                      title={r.exceptions ?? undefined}
                    >
                      {r.exceptions ? "Exceptions noted" : "Nothing to report"}
                    </span>
                  ) : null}
                  {r.certificateUrl ? (
                    <a
                      href={r.certificateUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <FileDown className="size-3.5" strokeWidth={1.75} />
                      PDF
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-xs text-mist-400">
        <ShieldCheck className="size-3.5" strokeWidth={1.75} />
        Documents are evidence — they can&apos;t be edited or deleted, and each quote/enquiry page shows its own in context.
      </p>
    </main>
  );
}
