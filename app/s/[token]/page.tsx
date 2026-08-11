import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { UNIT_TYPES } from "@/lib/storage-units";
import { crateStorageAcks, STORAGE_ACKS } from "@/lib/signatures";
import { publicUrlFor } from "@/lib/legal/documents";
import { getStorageRates, gbpInc } from "@/lib/storage-rates";
import { StorageAgreementForm } from "./agreement-form";

/**
 * /s/<token> — remote storage-agreement signing (Peter, 2026-07-10: in person
 * is the default; this is the option for no-one-on-site collections). Same
 * model as /q: the unguessable token IS the credential; noindex; the typed
 * name + acknowledgments are the signature, stored with IP/UA + a script
 * rendering of the name.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

const gbp = (n: number): string => "£" + Number(n).toFixed(2).replace(/\.00$/, "");

const prettyDay = (iso: string): string =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export default async function StorageSignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[\w-]{10,64}$/.test(token)) notFound();

  const admin = createAdminClient();
  const { data: let_ } = await admin
    .from("storage_lets")
    .select("id, client_id, unit_id, start_date, end_date, rate, rate_period, billing_model, min_days, min_amount")
    .eq("sign_token", token)
    .maybeSingle();
  if (!let_) notFound();

  const [{ data: client }, { data: unit }, { data: existing }] = await Promise.all([
    admin.from("clients").select("display_name").eq("id", let_.client_id).maybeSingle(),
    admin.from("storage_units").select("code, unit_type, site_id").eq("id", let_.unit_id).maybeSingle(),
    admin
      .from("signatures")
      .select("signer_name, signed_at")
      .eq("storage_let_id", let_.id)
      .eq("kind", "storage")
      .maybeSingle(),
  ]);
  const { data: site } = unit?.site_id
    ? await admin.from("storage_sites").select("name").eq("id", unit.site_id).maybeSingle()
    : { data: null };

  const typeLabel = UNIT_TYPES.find((t) => t.value === unit?.unit_type)?.label ?? "Storage unit";
  const unitLabel = `${typeLabel}${unit?.code ? ` ${unit.code}` : ""}${site?.name ? ` at ${site.name}` : ""}`;
  const firstName = (client?.display_name ?? "").trim().split(/\s+/)[0] || "there";
  const rateLabel = let_.rate ? `${gbp(Number(let_.rate))} per ${let_.rate_period}` : "as agreed";

  // The ack set follows the product: crates sign the billing schedule
  // (minimum + day-rate arrears + handling), containers keep the rate ack.
  const isCrate = (let_ as { billing_model?: string }).billing_model === "crate_daily";
  const rates = await getStorageRates(admin);
  const minDays = Number((let_ as { min_days?: number | null }).min_days ?? rates.crateMinDays);
  const minAmount = Number((let_ as { min_amount?: number | null }).min_amount ?? rates.crateMinInc);
  const ackList = (isCrate ? crateStorageAcks(minDays, gbpInc(rates.handlingEventInc)) : [...STORAGE_ACKS]).map(
    (a) => ({ key: a.key as string, label: a.label }),
  );

  return (
    <main className="mx-auto min-h-screen max-w-xl bg-mist-50 px-5 py-10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Marley Moves" width={170} className="mx-auto mb-6" />

      <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-mm-red">Storage agreement</p>
        <h1 className="mt-2 font-brand text-3xl font-semibold text-ink">
          {existing ? "All signed — thank you." : `Your storage with us, ${firstName}`}
        </h1>

        {existing ? (
          <p className="mt-4 text-sm leading-relaxed text-mist-500">
            This agreement was signed by <strong>{existing.signer_name}</strong> on{" "}
            {prettyDay(existing.signed_at)}. Nothing more to do — any questions, call{" "}
            <a href="tel:01747637070" className="font-semibold text-mm-red">
              01747 637070
            </a>
            .
          </p>
        ) : (
          <>
            <div className="mt-5 space-y-2 rounded-md border-l-4 border-mm-red bg-mm-red-tint/50 p-4 text-sm text-ink">
              <p>
                <strong>{unitLabel}</strong>
              </p>
              {isCrate ? (
                <p>
                  From <strong>{prettyDay(let_.start_date)}</strong> · <strong>{minDays}-day minimum</strong> (
                  {gbp(minAmount)}, invoiced upfront), then <strong>{rateLabel}</strong> charged to the exact day in
                  arrears. Handling is {gbpInc(rates.handlingEventInc)} per crate movement.
                  All charges are settled before your items are released.
                </p>
              ) : (
                <p>
                  From <strong>{prettyDay(let_.start_date)}</strong> · Rate <strong>{rateLabel}</strong>, billed in
                  advance each period until you end the storage. The final period is not part-refunded.
                </p>
              )}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-mist-400">
              {/* Storage customers were linked to the REMOVALS terms, which say
                  nothing about storage rates, access, or the notice procedure
                  behind the lien clause they are ticking. Now that storage terms
                  are published, point at those. */}
              This agreement is with MarleyMoves Ltd (Company No. 15914266) under our{" "}
              <a
                href={publicUrlFor("storage-terms")}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                storage agreement terms
              </a>
              . Invoices are payable by bank transfer on receipt.
            </p>

            <div className="mt-6">
              <StorageAgreementForm token={token} ackList={ackList} />
            </div>
          </>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-mist-400">
        Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7
        <br />
        Questions? Call{" "}
        <a href="tel:01747637070" className="font-semibold">
          01747 637070
        </a>
      </p>
    </main>
  );
}
