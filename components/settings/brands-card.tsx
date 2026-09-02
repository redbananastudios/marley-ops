"use client";

/**
 * Settings › Brands (admin, multi-brand only — the page renders this card only
 * when isMultiBrand() is true, so with one active brand /settings stays
 * byte-identical to today; the parity e2e asserts exactly that).
 *
 * One row per brands row, the `group` pseudo-brand included (marked internal
 * only). Admins edit the SAFE display fields — phone, address, review/terms/
 * logo URLs, the two colours, card payments — so Peter can tune details
 * himself through the rest of the build. Everything structural is read-only
 * display and changes by migration/runbook: a changed ref prefix breaks bank
 * reconciliation on refs already issued (the quote ref IS the bank-transfer
 * reference), and activation is a runbook step, never a UI action — flipping
 * `active` IS the app-wide brand-UI switch. The whitelist is enforced
 * server-side in lib/brand-update.ts; this form is just the polite surface.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateBrandAction } from "@/app/(dashboard)/settings/brand-actions";
import { DEFAULT_BRAND, GROUP_BRAND, type Brand } from "@/lib/brand";

const inputClass =
  "flex h-11 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:border-mm-red focus:ring-2 focus:ring-mm-red/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/** Read-only fact — value text with an em-dash placeholder for null. */
function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-wide text-mist-400 uppercase">{label}</dt>
      <dd className="truncate text-sm text-foreground" title={value ?? undefined}>
        {value ?? "—"}
      </dd>
    </div>
  );
}

/** Small colour swatch beside the hex input — neutral checker look for empty. */
function Swatch({ hex }: { hex: string }) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex.trim());
  return (
    <span
      aria-hidden
      className="inline-block size-6 shrink-0 rounded-md border border-border"
      style={valid ? { backgroundColor: hex.trim() } : undefined}
    />
  );
}

function BrandRow({ brand }: { brand: Brand }) {
  const router = useRouter();
  const isGroup = brand.slug === GROUP_BRAND;
  // The DEFAULT brand's per-brand card flag is deliberately dead end-to-end
  // (QA-20260826-07 remainder: cardPaymentsAvailable short-circuits it,
  // cardEnabledBrands seeds it, emailTheme themes Marley regardless). A live
  // checkbox here would be a dead control asserting a state the runtime
  // ignores — so it renders disabled with a truthful caption, and the server
  // (sanitizeBrandUpdate) refuses to persist the field for this row anyway.
  const isDefault = brand.slug === DEFAULT_BRAND;
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState(brand.phone ?? "");
  const [address, setAddress] = useState(brand.address ?? "");
  const [reviewUrl, setReviewUrl] = useState(brand.reviewUrl ?? "");
  const [termsUrl, setTermsUrl] = useState(brand.termsUrl ?? "");
  const [logoUrl, setLogoUrl] = useState(brand.logoUrl ?? "");
  const [colourPrimary, setColourPrimary] = useState(brand.colourPrimary ?? "");
  const [colourAccent, setColourAccent] = useState(brand.colourAccent ?? "");
  const [cardPayments, setCardPayments] = useState(brand.cardPaymentsEnabled);

  async function save() {
    setBusy(true);
    const res = await updateBrandAction(brand.slug, {
      phone,
      address,
      reviewUrl,
      termsUrl,
      logoUrl,
      colourPrimary,
      colourAccent,
      cardPaymentsEnabled: cardPayments,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not save.");
      return;
    }
    toast.success(`${brand.shortName || brand.name} saved.`);
    router.refresh();
  }

  const primary = (brand.colourPrimary ?? "").trim();
  const monogramHex = /^#[0-9a-fA-F]{6}$/.test(primary) ? primary : undefined;

  return (
    <div className="border-t px-5 py-4 first:border-t-0">
      {/* Identity row — read-only facts. */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-mist-500 text-xs font-semibold text-white"
          style={monogramHex ? { backgroundColor: monogramHex } : undefined}
        >
          {brand.initial ?? (brand.shortName || brand.name).charAt(0)}
        </span>
        <p className="text-sm font-semibold text-foreground">{brand.name}</p>
        <span className="text-xs text-mist-400">{brand.shortName}</span>
        {brand.refPrefix ? (
          <span
            className="tabular rounded-md border border-border bg-mist-100 px-1.5 py-0.5 text-[11px] font-medium text-mist-500"
            title="Ref prefix — read-only: refs already issued are matched by the bank feed, so this changes by migration only."
          >
            Refs {brand.refPrefix}
          </span>
        ) : null}
        {isGroup ? (
          <span className="rounded-md bg-mist-100 px-1.5 py-0.5 text-[11px] font-medium text-mist-500">
            Internal only
          </span>
        ) : null}
        {!brand.active ? (
          <span
            className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
            title="Activation is a runbook step, never a UI action — flipping it switches the brand UI app-wide."
          >
            Inactive
          </span>
        ) : null}
        {!isGroup ? (
          <span className="ml-auto text-[11px] text-mist-400">
            {isDefault
              ? "Card payments — global switch"
              : `Card payments ${brand.cardPaymentsEnabled ? "on" : "off"}`}
          </span>
        ) : null}
      </div>

      {isGroup ? (
        <p className="mt-1.5 text-xs text-mist-400">
          The cross-brand pseudo-brand — day sheets, contractor statements, /join and /manual. Never
          customer-facing, mints no refs.
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Meta label="Hello from" value={brand.helloFrom} />
        <Meta label="Accounts from" value={brand.accountsFrom} />
        <Meta label="Email domain" value={brand.emailDomain} />
        <Meta label="Reply domain" value={brand.replyDomain} />
        <Meta label="SMS sender" value={brand.smsSender} />
        <Meta label="Initial" value={brand.initial} />
      </dl>

      {/* Editable safe display fields. */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-phone`}>Phone</Label>
          <input
            id={`brand-${brand.slug}-phone`}
            type="tel"
            value={phone}
            disabled={busy}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-address`}>Address</Label>
          <input
            id={`brand-${brand.slug}-address`}
            type="text"
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-colour-primary`}>Primary colour</Label>
          <div className="flex items-center gap-2">
            <Swatch hex={colourPrimary} />
            <input
              id={`brand-${brand.slug}-colour-primary`}
              type="text"
              value={colourPrimary}
              disabled={busy}
              onChange={(e) => setColourPrimary(e.target.value)}
              placeholder="#1A1A1A"
              className={inputClass}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-colour-accent`}>Accent colour</Label>
          <div className="flex items-center gap-2">
            <Swatch hex={colourAccent} />
            <input
              id={`brand-${brand.slug}-colour-accent`}
              type="text"
              value={colourAccent}
              disabled={busy}
              onChange={(e) => setColourAccent(e.target.value)}
              placeholder="#C03838"
              className={inputClass}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-logo-url`}>Logo URL</Label>
          <input
            id={`brand-${brand.slug}-logo-url`}
            type="url"
            value={logoUrl}
            disabled={busy}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            className={inputClass}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`brand-${brand.slug}-review-url`}>Review link</Label>
          <input
            id={`brand-${brand.slug}-review-url`}
            type="url"
            value={reviewUrl}
            disabled={busy}
            onChange={(e) => setReviewUrl(e.target.value)}
            placeholder="https://g.page/r/…/review"
            className={inputClass}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={`brand-${brand.slug}-terms-url`}>Terms link</Label>
          <input
            id={`brand-${brand.slug}-terms-url`}
            type="url"
            value={termsUrl}
            disabled={busy}
            onChange={(e) => setTermsUrl(e.target.value)}
            placeholder="https://…/terms-conditions"
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        {!isGroup ? (
          <div className="flex items-center gap-3">
            <input
              id={`brand-${brand.slug}-card-payments`}
              type="checkbox"
              checked={isDefault ? true : cardPayments}
              disabled={busy || isDefault}
              onChange={(e) => setCardPayments(e.target.checked)}
              aria-label={`Card payments for ${brand.name}`}
              className="size-6 shrink-0 accent-mm-red"
            />
            <div>
              <Label htmlFor={`brand-${brand.slug}-card-payments`}>Card payments</Label>
              {isDefault ? (
                <p className="text-xs text-mist-400">
                  {brand.shortName || brand.name} card payments follow the global Payments kill switch
                  — this per-brand switch only applies to other brands.
                </p>
              ) : (
                <p className="text-xs text-mist-400">
                  Card on /q and the office payment link — only when this AND the global Payments kill
                  switch are on.
                </p>
              )}
            </div>
          </div>
        ) : (
          <span />
        )}
        <Button onClick={save} disabled={busy} className="h-11">
          {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
          Save {brand.shortName || brand.name}
        </Button>
      </div>
    </div>
  );
}

export function BrandsCard({ brands }: { brands: Brand[] }) {
  return (
    <Card className="p-0" data-testid="brand-settings-card">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <Building2 className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Brands</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Display details per brand. Slug, ref prefix and activation are structural — they change
            by migration/runbook, never here.
          </p>
        </div>
      </div>
      <div>
        {brands.map((brand) => (
          <BrandRow key={brand.slug} brand={brand} />
        ))}
      </div>
    </Card>
  );
}
