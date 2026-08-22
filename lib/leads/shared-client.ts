/**
 * One lead versus the `clients` row it shares with its siblings.
 *
 * Dedup deliberately attaches several enquiries to a single client (the same
 * customer moving twice, or enquiring twice with a typo). That makes "the
 * customer's name" ambiguous on a lead page, and QA-20260819-01 is what
 * happens when the ambiguity is resolved ad hoc: the precedence was written out
 * by hand at six call sites on `/leads/[id]`, the header used one rule and the
 * Contact card the other, and the page contradicted itself. Both rules live
 * here now so every surface answers identically and a change moves them
 * together.
 */

export interface LeadContactFields {
  name: string | null;
  phone: string | null;
  email: string | null;
  from_postcode: string | null;
}

export interface ClientContactFields {
  display_name: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  email: string | null;
  postcode_home: string | null;
}

export interface LeadContact {
  name: string | null;
  phone: string | null;
  email: string | null;
  postcode: string | null;
}

/**
 * What THIS enquiry's contact details are.
 *
 * The lead's own captured values win; the shared client is a fallback for a
 * field this lead never captured, never an override for one it did. A fallback
 * cannot reintroduce the bug — it only fills a blank, so it can never
 * contradict a value the page is showing elsewhere.
 */
export function leadContact(
  lead: LeadContactFields,
  client: ClientContactFields | null | undefined,
): LeadContact {
  return {
    name: lead.name ?? client?.display_name ?? null,
    phone: lead.phone ?? client?.phone_raw ?? client?.phone_e164 ?? null,
    email: lead.email ?? client?.email ?? null,
    postcode: lead.from_postcode ?? client?.postcode_home ?? null,
  };
}

export interface ClientWriteThrough {
  write: boolean;
  /** Non-null whenever the office would otherwise assume more was saved. */
  warning: string | null;
}

/**
 * Whether editing this lead may also rewrite the shared `clients` row.
 *
 * Only when this is the sole enquiry on it. The write exists so correcting a
 * bounced address fixes the customer record too, which is right for the normal
 * one-lead-per-client case and wrong the moment a sibling exists — it silently
 * republished one customer's details as another's.
 *
 * Declining is NOT silent. `clients.email` is a live sending surface (storage
 * invoices are addressed from it), so an office that corrected an address has
 * to be told the customer record still holds the old one. `otherLeadCount:
 * null` means the check itself failed, which must read as "not done", never as
 * "nothing to do".
 */
export function clientWriteThrough(input: {
  clientId: string | null | undefined;
  otherLeadCount: number | null;
}): ClientWriteThrough {
  if (!input.clientId) return { write: false, warning: null };
  if (input.otherLeadCount === null) {
    return {
      write: false,
      warning:
        "Saved this enquiry, but we couldn't check whether other enquiries share this customer, so the customer record was left unchanged.",
    };
  }
  if (input.otherLeadCount > 0) {
    const n = input.otherLeadCount;
    return {
      write: false,
      warning:
        `Saved this enquiry. ${n} other ${n === 1 ? "enquiry shares" : "enquiries share"} this customer, ` +
        "so the shared customer record was left unchanged — edit it on the customer page if the change applies to all of them.",
    };
  }
  return { write: true, warning: null };
}
