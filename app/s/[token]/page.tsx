import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { UNIT_TYPES } from "@/lib/storage-units";
import { crateMinimumLabel, crateStorageAcks, STORAGE_ACKS } from "@/lib/signatures";
import {
  publicUrlFor,
  STORAGE_PAYMENT_SENTENCE,
  STORAGE_PAYMENT_SENTENCE_NO_CARD,
} from "@/lib/legal/documents";
import { getStorageRates, gbpInc } from "@/lib/storage-rates";
import { getBrandOrDefault } from "@/lib/brand";
import { cardPaymentsAvailable } from "@/lib/payments/card-availability";
import { pageTheme, pageTitle } from "@/lib/brand-page-theme";
import { StorageAgreementForm } from "./agreement-form";

/**
 * /s/<token> — remote storage-agreement signing (Peter, 2026-07-10: in person
 * is the default; this is the option for no-one-on-site collections). Same
 * model as /q: the unguessable token IS the credential; noindex; the typed
 * name + acknowledgments are the signature, stored with IP/UA + a script
 * rendering of the name.
 */

export const dynamic = "force-dynamic";

/** Brand-resolved (gate 16): the tab title names the brand whose storage this
 *  is, resolved from the let's own brand column. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("storage_lets")
    .select("brand")
    .eq("sign_token", token)
    .maybeSingle();
  const theme = pageTheme(row ? await getBrandOrDefault(admin, row.brand) : null);
  return { title: pageTitle(theme, "Storage agreement"), robots: { index: false, follow: false } };
}

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
    .select(
      "id, client_id, unit_id, start_date, end_date, rate, rate_period, billing_model, min_days, min_amount, min_kind, brand",
    )
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
  const minKind = (let_ as { min_kind?: string | null }).min_kind ?? null;
  const minAmount = Number((let_ as { min_amount?: number | null }).min_amount ?? rates.crateMinInc);
  // The SAME wording the ack stores and the billing engine enforces —
  // "one calendar month minimum" for v2-terms lets, "N-day minimum" legacy.
  const minLabel = crateMinimumLabel(minKind, minDays);
  const ackList = (
    isCrate ? crateStorageAcks({ kind: minKind, days: minDays }, gbpInc(rates.handlingEventInc)) : [...STORAGE_ACKS]
  ).map((a) => ({ key: a.key as string, label: a.label }));

  // Identity comes from the LET's own brand (gate 12 put the column there),
  // resolved once before the render.
  const theme = pageTheme(await getBrandOrDefault(admin, let_.brand));

  // The payment-method sentence names "card" only when this LET's brand has a
  // LIVE card channel (the §11.10 two-switch verdict: global kill switch AND
  // the brand's own switch). A brand with card off — every rail bank-only —
  // must not have this page offer a method its invoices will refuse. Fails
  // safe to the no-card copy, same direction as lib/comms/quote-email.ts.
  const cardOk = await cardPaymentsAvailable(admin, let_.brand);

  return (
    // One CSS-variable override re-points every mm-red utility below to this
    // brand's accent — the same mechanism /q uses. Undefined for the default
    // brand, so its markup and colours are unchanged.
    <main
      className="mx-auto min-h-screen max-w-xl bg-mist-50 px-5 py-10"
      style={theme.rootStyle as React.CSSProperties | undefined}
    >
      {theme.logoUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={theme.logoUrl} alt={theme.name} width={170} className="mx-auto mb-6" />
      ) : (
        <p
          className="mb-6 text-center font-brand text-2xl font-bold tracking-tight"
          style={{ color: theme.wordmarkColour }}
        >
          {theme.name}
        </p>
      )}
      {theme.groupLine ? (
        <p className="-mt-4 mb-6 text-center text-xs font-medium text-mist-400">{theme.groupLine}</p>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-mm-red">Storage agreement</p>
        <h1 className="mt-2 font-brand text-3xl font-semibold text-ink">
          {existing ? "All signed — thank you." : `Your storage with us, ${firstName}`}
        </h1>

        {existing ? (
          <p className="mt-4 text-sm leading-relaxed text-mist-500">
            This agreement was signed by <strong>{existing.signer_name}</strong> on{" "}
            {prettyDay(existing.signed_at)}. Nothing more to do — any questions, call{" "}
            <a href={theme.telHref} className="font-semibold text-mm-red">
              {theme.phone}
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
                  From <strong>{prettyDay(let_.start_date)}</strong> · <strong>{minLabel}</strong> (
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
              This agreement is with {theme.legalEntity} (Company No. 15914266)
              {theme.groupLine ? `, trading as ${theme.name},` : ""} under our{" "}
              <a
                href={publicUrlFor("storage-terms")}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                storage agreement terms
              </a>
              . {cardOk ? STORAGE_PAYMENT_SENTENCE : STORAGE_PAYMENT_SENTENCE_NO_CARD}
            </p>

            <div className="mt-6">
              <StorageAgreementForm token={token} ackList={ackList} phone={theme.phone} />
            </div>
          </>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-mist-400">
        {theme.legalLine}
        <br />
        Questions? Call{" "}
        <a href={theme.telHref} className="font-semibold">
          {theme.phone}
        </a>
      </p>
    </main>
  );
}
