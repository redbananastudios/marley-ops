"use client";

/**
 * The one address block used everywhere (clients, leads, quotes) so addresses stay
 * conformant across the system. Separated fields — street / town / county / postcode /
 * country — with Google lookup on two fronts:
 *   - Street Address autocompletes and, on select, autofills every field from Place Details.
 *   - Postcode autocompletes and, on select, fills town + county + postcode.
 * Both degrade to plain typing if Places is unavailable. Controlled: pass `value` + `onChange`.
 */

import { useCallback, useState } from "react";
import { PlacesInput } from "@/components/places/places-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lookupPlaceDetails } from "@/lib/places/lookup";

export interface AddressValue {
  line1: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
}

export const BLANK_ADDRESS: AddressValue = {
  line1: "",
  town: "",
  county: "",
  postcode: "",
  country: "United Kingdom",
};

/** One-line string (line1, town, postcode) for storage in a single text column. */
export function formatAddress(a: AddressValue): string {
  return [a.line1, a.town, a.postcode].filter((s) => s && s.trim()).join(", ").trim();
}

/** Full UK postcode, tolerant of the internal space (e.g. "SP7 9PX", "ba80tg"). */
const UK_POSTCODE_FULL = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/;
/** Bare outward code only (e.g. "SP7", "BA8", "EC1A"). */
const UK_POSTCODE_OUTWARD = /^[A-Za-z]{1,2}\d[A-Za-z\d]?$/;

/**
 * Seed an AddressValue from a stored one-line string (back-compat for single-column
 * addresses). Pulls a UK postcode into the postcode field — so a lead carrying only a
 * postcode doesn't land it in the street field — and splits a trailing town when the
 * string is comma-separated (e.g. "Ash Cottage, Shaftesbury, SP7 9PX").
 */
export function addressFromString(s: string | null | undefined): AddressValue {
  const raw = (s ?? "").trim();
  if (!raw) return { ...BLANK_ADDRESS };

  // Bare outward code ("SP7") — straight into postcode.
  if (UK_POSTCODE_OUTWARD.test(raw)) return { ...BLANK_ADDRESS, postcode: raw.toUpperCase() };

  let postcode = "";
  let rest = raw;
  const m = raw.match(UK_POSTCODE_FULL);
  if (m && m.index != null) {
    postcode = `${m[1]} ${m[2]}`.toUpperCase();
    rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length))
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
  }

  const parts = rest.split(",").map((p) => p.trim()).filter(Boolean);
  // With a postcode anchor and ≥2 segments, the last segment is most likely the town.
  if (postcode && parts.length >= 2) {
    return { ...BLANK_ADDRESS, line1: parts.slice(0, -1).join(", "), town: parts[parts.length - 1], postcode };
  }
  return { ...BLANK_ADDRESS, line1: parts.join(", "), postcode };
}

export function AddressFields({
  value,
  onChange,
  idPrefix = "addr",
}: {
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  idPrefix?: string;
}) {
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AddressValue>) => onChange({ ...value, ...patch });

  // Street pick → fill everything we got back; keep anything Google omitted.
  const onStreetPick = useCallback(
    async (p: { id: string; description: string }) => {
      setBusy(true);
      const a = await lookupPlaceDetails(p.id);
      setBusy(false);
      if (!a) return;
      onChange({
        line1: a.line1 || value.line1,
        town: a.town || value.town,
        county: a.county || value.county,
        postcode: a.postcode || value.postcode,
        country: a.country || value.country || "United Kingdom",
      });
    },
    [onChange, value],
  );

  // Postcode pick → fill town/county/postcode, leave the street the user typed.
  const onPostcodePick = useCallback(
    async (p: { id: string; main: string }) => {
      setBusy(true);
      const a = await lookupPlaceDetails(p.id);
      setBusy(false);
      onChange({
        ...value,
        postcode: a?.postcode || p.main || value.postcode,
        town: a?.town || value.town,
        county: a?.county || value.county,
      });
    },
    [onChange, value],
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-line1`}>Street address</Label>
        <PlacesInput
          id={`${idPrefix}-line1`}
          kind="address"
          value={value.line1}
          onValueChange={(v) => set({ line1: v })}
          onPick={onStreetPick}
          placeholder="Start typing an address…"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-town`}>Town / City</Label>
          <Input
            id={`${idPrefix}-town`}
            value={value.town}
            onChange={(e) => set({ town: e.target.value })}
            placeholder="Town or city"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-postcode`}>Postcode</Label>
          <PlacesInput
            id={`${idPrefix}-postcode`}
            kind="postcode"
            value={value.postcode}
            onValueChange={(v) => set({ postcode: v })}
            onPick={onPostcodePick}
            placeholder="Postcode"
            inputMode="text"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-county`}>County</Label>
          <Input
            id={`${idPrefix}-county`}
            value={value.county}
            onChange={(e) => set({ county: e.target.value })}
            placeholder="County"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-country`}>Country</Label>
          <Input
            id={`${idPrefix}-country`}
            value={value.country}
            onChange={(e) => set({ country: e.target.value })}
            placeholder="Country"
          />
        </div>
      </div>

      {busy ? <p className="text-xs text-mist-400">Looking up address…</p> : null}
    </div>
  );
}
