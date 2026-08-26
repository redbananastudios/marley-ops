import { NextResponse } from "next/server";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildContractDocDef, type ContractDocData } from "@/lib/contract-docdef";
import { renderPdfBuffer } from "@/lib/pdf/server-pdf";
import { DEFAULT_BRAND, getBrandOrDefault } from "@/lib/brand";
import { docBrandFrom, type DocBrand } from "@/lib/pdf/doc-brand";
import { versionById } from "@/lib/legal/documents";
import { signatureKindLabel } from "@/lib/signatures";
import { errorContext, log } from "@/lib/log";
import { UK_TZ } from "@/lib/uk-time";

/**
 * The signed contract as a downloadable PDF.
 *
 * Generated on demand from the signature row rather than stored: everything it
 * renders (the terms text, its hash, the acknowledgment wording, the signature,
 * the timestamp) was captured immutably at signing by migration 0093, so the
 * document is deterministic from evidence we already hold. Storing a copy would
 * add a second artifact that can go missing, and generating one at signing
 * would put a PDF render on the customer's accept path — where a failure either
 * blocks the signature or leaves a contract with no document.
 *
 * Office-only, and enforced here rather than inherited: it contains the
 * customer's signature image and IP address. The (dashboard) layout bounces
 * crew off office PAGES, but /api/** has no layout, and this route reads
 * through the RLS-bypassing admin client — so nothing behind it would catch a
 * crew session. requireApiUser() authenticates without checking a role and was
 * the wrong helper (QA-20260821-01).
 */

export const dynamic = "force-dynamic";

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: UK_TZ,
  });

const money = (n: number | null | undefined): string | null =>
  typeof n === "number" && n > 0 ? `£${n.toFixed(2)}` : null;

export async function GET(_req: Request, ctx: { params: Promise<{ signatureId: string }> }) {
  // Refuse before the signature is looked up, so the reply is identical whether
  // or not the id exists — a non-office caller learns nothing either way.
  if (!(await requireOfficeProfile())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 403 });
  }

  const { signatureId } = await ctx.params;
  const sb = createAdminClient();

  const { data: sig, error } = await sb
    .from("signatures")
    .select(
      "id, kind, quote_id, lead_id, signer_name, signature_data, method, channel, acknowledgments, acknowledgment_labels, terms_version, terms_sha256, terms_snapshot, signed_at, ip, collected_by",
    )
    .eq("id", signatureId)
    .maybeSingle();
  if (error) {
    log.error("contract_pdf.lookup_failed", { signatureId, error: error.message });
    return NextResponse.json({ error: "Could not load the signature" }, { status: 500 });
  }
  if (!sig) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A signature taken before 0093 has no snapshot and cannot be rendered
  // honestly. Say so rather than substituting today's terms, which would put
  // words in the customer's mouth. The backfill has closed this for every row
  // on prod, so this is a guard against a future gap, not a live state.
  if (!sig.terms_snapshot) {
    return NextResponse.json(
      { error: "This signature predates terms capture, so the exact terms agreed cannot be reproduced." },
      { status: 409 },
    );
  }

  const [{ data: quote }, { data: lead }, { data: collector }] = await Promise.all([
    sig.quote_id
      ? sb
          .from("quotes")
          .select("quote_ref, customer_name, moving_date, agreed_price, grand_total, brand")
          .eq("id", sig.quote_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    sig.lead_id
      ? sb.from("leads").select("name, from_address, from_postcode, to_address, to_postcode, brand").eq("id", sig.lead_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sig.collected_by
      ? sb.from("profiles").select("full_name").eq("id", sig.collected_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const version = versionById(sig.terms_version);
  const labels = (sig.acknowledgment_labels ?? {}) as Record<string, string>;
  const ticked = (sig.acknowledgments ?? {}) as Record<string, unknown>;

  // Prefer the wording captured at signing. Fall back to the published version's
  // wording only if labels are missing, and never to today's constants.
  const ackSource = Object.keys(labels).length
    ? Object.entries(labels)
    : (version?.acknowledgments ?? []).map((a) => [a.key, a.label] as const);

  const addr = (a?: string | null, p?: string | null) => [a, p].filter(Boolean).join(", ");

  // A contract is a JOB document — it carries the job's brand (PRD §3.6). The
  // quote's brand wins (the ref was minted from it); a quote-less signature
  // falls to the lead's. DEFAULT_BRAND skips the read entirely: the doc-def's
  // own constants ARE that rendering, byte-identical to today.
  const brandSlug = quote?.brand ?? lead?.brand ?? DEFAULT_BRAND;
  const docBrand: DocBrand | null =
    brandSlug === DEFAULT_BRAND ? null : docBrandFrom(await getBrandOrDefault(sb, brandSlug));

  const data: ContractDocData = {
    documentTitle: signatureKindLabel(sig.kind),
    quoteRef: quote?.quote_ref ?? null,
    customerName: quote?.customer_name || lead?.name || sig.signer_name,
    moveDate: quote?.moving_date ?? null,
    from: addr(lead?.from_address, lead?.from_postcode),
    to: addr(lead?.to_address, lead?.to_postcode),
    priceLabel: money(quote?.agreed_price ?? quote?.grand_total),
    signerName: sig.signer_name,
    signatureImage: sig.signature_data,
    method: sig.method,
    channel: sig.channel,
    signedAtLabel: fmtAt(sig.signed_at),
    collectedByName: collector?.full_name ?? null,
    ip: sig.ip,
    acknowledgments: ackSource.map(([key, label]) => ({ label, ticked: ticked[key] === true })),
    termsTitle: version?.title ?? "Terms",
    termsVersionId: sig.terms_version ?? "unknown",
    termsSha256: sig.terms_sha256 ?? "",
    termsBody: sig.terms_snapshot,
    legalReviewPending: (version?.legal_review ?? "pending") !== "reviewed",
    brand: docBrand,
  };

  try {
    const pdf = await renderPdfBuffer(buildContractDocDef(data));
    // Brand-prefixed filename (PRD §10); the default-brand name is unchanged.
    const ref = quote?.quote_ref ?? sig.id.slice(0, 8);
    const name = docBrand
      ? `${docBrand.shortName}-${sig.kind.replace("_", "-")}-${ref}.pdf`
      : `marley-moves-${sig.kind.replace("_", "-")}-${ref}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}"`,
        // Evidence, and it contains an IP address: never cached by a proxy.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    log.error("contract_pdf.render_failed", { signatureId, ...errorContext(err) });
    return NextResponse.json({ error: "Could not render the document" }, { status: 500 });
  }
}
