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
