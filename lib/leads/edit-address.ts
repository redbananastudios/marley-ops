/**
 * The edit-lead dialog's bridge between the lead's TWO stored address columns
 * (the one-line *_address text and the separate *_postcode) and the structured
 * AddressFields state. Lives outside the dialog so the round-trip is unit-testable
 * without the dialog's server-action import graph.
 */

import { addressFromLead, type ParsedAddress } from "@/lib/places/parse";

/** Build the dialog's structured address from the lead's stored line + postcode.
 *
 *  Manually-entered leads bake the postcode INTO the stored *_address text
 *  (formatAddress joins line1, town, postcode on the create path), so the line
 *  must be parsed apart here, not dumped raw into line1 — otherwise the old
 *  postcode rides along as plain text inside the street field and streetPart()
 *  re-serialises it back into *_address on every save, whatever the Postcode
 *  field was changed to (QA-20260905-04). When the parsed text and the stored
 *  postcode column disagree, the column wins — it is what the lead page's
 *  Route line already shows. */
export function seedAddress(line: string, postcode: string): ParsedAddress {
  const parsed = addressFromLead(line, postcode);
  return { ...parsed, postcode: (postcode || "").trim() || parsed.postcode };
}

/** The street part (line1 + town + county) stored back into the lead's *_address column. */
export function streetPart(a: ParsedAddress): string {
  return [a.line1, a.town, a.county].filter((s) => s && s.trim()).join(", ").trim();
}
