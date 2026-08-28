"use client";

/**
 * The one address block used everywhere (clients, leads, quotes) so addresses stay
 * conformant across the system. Separated fields — street / town / county / postcode —
 * with Google lookup on two fronts:
 *   - Street Address autocompletes and, on select, autofills every field from Place Details.
 *   - Postcode autocompletes and, on select, fills town + county + postcode.
 * Both degrade to plain typing if Places is unavailable. Controlled: pass `value` + `onChange`.
 *
 * Country is NOT rendered (Peter, 2026-08-14) — Marley moves UK homes; the value is
 * hard-coded "United Kingdom" in the AddressValue so every storage path keeps working.
 */

import { useCallback, useState } from "react";
import { PlacesInput } from "@/components/places/places-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lookupPlaceDetails } from "@/lib/places/lookup";
import { addressFromString as parseAddressString, type ParsedAddress } from "@/lib/places/parse";
import { formatUkPostcode } from "@/lib/leads/format";

export type AddressValue = ParsedAddress;

export const BLANK_ADDRESS: AddressValue = {
  line1: "",
  town: "",
  county: "",
  postcode: "",
  country: "United Kingdom",
};

/** One-line string (line1, town, postcode) for storage in a single text column.
 *
 *  The postcode goes through the SAME canonical normaliser the server applies
 *  to leads.from_postcode / to_postcode. Without it a hand-typed postcode (no
 *  Places pick) was stored raw here while the sibling column was normalised, so
 *  the lead page showed Route "BH21 8NB" beside Pickup address "bh218nb" - one
 *  value, two renderings, on one screen (QA-20260827-05).
 *
 *  formatUkPostcode returns "" for empty input, so a blank postcode is
 *  unchanged. */
export function formatAddress(a: AddressValue): string {
  return [a.line1, a.town, formatUkPostcode(a.postcode)].filter((s) => s && s.trim()).join(", ").trim();
}

/** Seed an AddressValue from a stored one-line string (shared parser in lib/places/parse). */
export const addressFromString = parseAddressString;

/**
 * Google's UK street/route-level autocomplete results carry NO street_number and NO
 * postal_code, so a Place Details lookup for "12 High Street" comes back as line1
 * "High Street" (house number dropped) with a blank postcode. Merge the user's typed
 * premise number back onto Google's street so it isn't silently lost. Full house-level
 * results (line1 already starts with a number) pass through untouched.
 */
function mergePremiseNumber(googleLine1: string, typedLine1: string): string {
  const g = (googleLine1 || "").trim();
  const typed = (typedLine1 || "").trim();
  if (!g) return typed; // Google gave nothing usable → keep what the user typed.
  if (/^\d/.test(g)) return g; // Full house-level result already carries the number.
  const m = typed.match(/^(\d+[A-Za-z]?)\b/); // Leading UK premise number, e.g. "12" / "12a" / "221b".
  return m ? `${m[1]} ${g}` : g;
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

  // Street pick → fill everything we got back; keep anything Google omitted. For a
  // UK street-level result Google drops the house number and postcode, so merge the
  // typed premise number back onto the street and never blank an existing postcode.
  const onStreetPick = useCallback(
    async (p: { id: string; description: string }) => {
      setBusy(true);
      const a = await lookupPlaceDetails(p.id);
      setBusy(false);
      if (!a) return;
      onChange({
        line1: mergePremiseNumber(a.line1, value.line1),
        town: a.town || value.town,
        county: a.county || value.county,
        postcode: a.postcode || value.postcode, // only overwrite when Google returns one
        country: "United Kingdom",
      });
    },
    [onChange, value],
  );

  // Postcode pick → fill town/county/postcode; when the chosen result is a full
  // address (Google mixes those into postcode searches) the street fills too. Same
  // non-destructive rules: keep the typed premise number, never blank the postcode.
  const onPostcodePick = useCallback(
    async (p: { id: string; main: string }) => {
      setBusy(true);
      const a = await lookupPlaceDetails(p.id);
      setBusy(false);
      onChange({
        ...value,
        line1: mergePremiseNumber(a?.line1 ?? "", value.line1),
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

      {/* Town/City full width (Peter 2026-08-14: it needs the room), then County,
          then Postcode on its OWN line below County — never squeezed beside town. */}
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-town`}>Town / City</Label>
        <Input
          id={`${idPrefix}-town`}
          value={value.town}
          onChange={(e) => set({ town: e.target.value })}
          placeholder="Town or city"
        />
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
      </div>

      <div className="grid grid-cols-2 gap-3">
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

      {busy ? <p className="text-xs text-mist-400">Looking up address…</p> : null}
    </div>
  );
}
