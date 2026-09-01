import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BRAND, type Brand } from "@/lib/brand";

/**
 * Sender identity — the ONE place that decides which address an email comes
 * from (docs/email-identity-plan.md, approved by Peter 2026-07-16):
 *
 *  - hello@    front door + fallback identity (whole office monitors it)
 *  - accounts@ money desk: quote emails (Peter, 2026-07-30), receipts,
 *              invoices, refunds send from it; payment ops alerts route to it
 *  - luke@/connor@/…  personal sales identity — a team member's SENDING address
 *              is their ops login email when it's on the marleymoves.co.uk
 *              domain (anything else falls back to hello@, so a .test login or
 *              a personal gmail can never leak into a customer's inbox)
 *  - peter@    system-failure alerts
 *
 * Every From here is on the Resend-verified apex domain, so DKIM/DMARC hold
 * for all of them. Reply-To is NOT decided here — lead-linked emails keep the
 * tokenized reply relay (lib/quote/chase.ts replyAddressFor).
 */

export const MARLEY_EMAIL_DOMAIN = "marleymoves.co.uk";
export const HELLO_FROM = "Marley Moves <hello@marleymoves.co.uk>";

/** The money desk's bare address (env-overridable) and full From identity. */
export function accountsAddress(): string {
  return process.env.ACCOUNTS_EMAIL || "accounts@marleymoves.co.uk";
}
export function accountsFrom(): string {
  // Display name is the plain brand (Peter, 2026-07-30) — customers see
  // "Marley Moves" everywhere; only the address marks the money desk.
  return `Marley Moves <${accountsAddress()}>`;
}

/* --------------------------------------------------- brand-aware identities */

/**
 * Strip address/header syntax from a display-name PHRASE — ownerFrom's strip
 * set plus "@": a multi-word name keeps its spaces, so a smuggled bare address
 * ("Evil <attacker@evil.test>") cannot survive as an @-token in the phrase and
 * a CR/LF cannot break out of the header. The ONE hardening every interpolation
 * of a brands.name display value must go through — brandFrom here plus the
 * tokenized reply relay (replyAddressFor / latestReplyAddressForLead), which
 * receive the same value. Empty when nothing survives; callers pick their own
 * fallback.
 */
export const sanitizeDisplayName = (name: string | null | undefined): string =>
  (name ?? "").replace(/[<>"\\;,@\r\n]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Build "Brand Name <address>" from a brands-table row, with the same header
 * hardening as ownerFrom: the display name (office-editable in Settings) loses
 * any address/header syntax, and the address must be a plain local@domain
 * token. Null when either half is unusable — callers fall back to the Marley
 * house identity, because a deliverable Marley From (visible, fixable) beats a
 * malformed From that Resend rejects (silent non-delivery).
 */
const brandFrom = (brand: Pick<Brand, "name">, address: string | null): string | null => {
  const addr = plainAddress(address);
  if (!addr) return null;
  const display = sanitizeDisplayName(brand.name);
  if (!display) return null;
  return `${display} <${addr}>`;
};

/**
 * A brand's front-door From identity — "Pitmans Removals & Storage <info@…>".
 * For the DEFAULT brand this returns EXACTLY today's HELLO_FROM (byte-equal),
 * and any row without a usable hello_from (the group pseudo-brand seeds null —
 * group comms keep Marley's from-address, PRD §11.10) degrades to it too, so
 * every pre-brand-layer send is unchanged.
 */
export function helloFromFor(brand: Brand): string {
  if (brand.slug === DEFAULT_BRAND) return HELLO_FROM;
  return brandFrom(brand, brand.helloFrom) ?? HELLO_FROM;
}

/**
 * A brand's money-desk From identity. The DEFAULT brand resolves through
 * accountsFrom() — NOT the brands row — so the ACCOUNTS_EMAIL env override
 * keeps working exactly as today; a null accounts_from degrades the same way.
 */
export function accountsFromFor(brand: Brand): string {
  if (brand.slug === DEFAULT_BRAND) return accountsFrom();
  return brandFrom(brand, brand.accountsFrom) ?? accountsFrom();
}

/** Capitalise a name segment that arrives all-lower ("freddy") or all-upper
 *  ("FREDDY") -> "Freddy"; leave intentional mixed case (McDonald, O'Brien) alone. */
export const capName = (seg: string): string => {
  const letters = seg.replace(/[^A-Za-z]/g, "");
  if (!letters) return seg;
  if (letters === letters.toLowerCase() || letters === letters.toUpperCase()) {
    return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  }
  return seg;
};

/** Reject anything that could smuggle a second address or header syntax into
 *  the From — the address part must be a plain local@domain token. */
const plainAddress = (email: string | null | undefined): string | null => {
  const addr = (email ?? "").trim().toLowerCase();
  return /^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(addr) ? addr : null;
};

/**
 * Own-domain recognition (inbound/reply classification, PRD §11.7 trap 3):
 * the recognised set WIDENS to every active brand's domains, never swaps to
 * the current brand — threading `brand` through and substituting would
 * silently stop Marley recognising its own reply addresses. Marley's domain is
 * always in the set; `extraDomains` (from brandInboundDomains below) adds the
 * others. The zero-argument form is byte-identical to the pre-brand behaviour,
 * so sync callers need no change.
 */
const onDomain = (email: string | null | undefined, extraDomains: readonly string[] = []): string | null => {
  const addr = plainAddress(email);
  if (!addr) return null;
  if (addr.endsWith(`@${MARLEY_EMAIL_DOMAIN}`)) return addr;
  return extraDomains.some((d) => d && addr.endsWith(`@${d.trim().toLowerCase()}`)) ? addr : null;
};

/**
 * A team member's personal sending identity: "Luke at Marley Moves <luke@…>".
 * The ADDRESS is used only when it's on the company domain; the display name
 * falls back to the address's local part, and with neither name nor a usable
 * address this degrades to the plain house identity.
 *
 * `extraDomains` WIDENS the recognised set (see onDomain — never substitute):
 * pass only Resend-verified brand domains, since the address becomes a live
 * From. Today every login is on the Marley domain, so no caller needs it yet.
 */
export function ownerFrom(
  name: string | null | undefined,
  email: string | null | undefined,
  extraDomains: readonly string[] = [],
): string {
  const addr = onDomain(email, extraDomains);
  // Display names come from profiles.full_name (office-editable free text) —
  // strip header/address syntax so a name can never break out of the display
  // slot ("Luke <x@y>" stays a name, not a second address).
  const cleaned = (name ?? "").replace(/[<>"\\;,\r\n]/g, " ").trim();
  const firstWord = cleaned.split(/\s+/)[0] ?? "";
  const display = firstWord ? capName(firstWord) : addr ? capName(addr.split("@")[0]) : "";
  if (!display) return HELLO_FROM;
  return `${display} at Marley Moves <${addr ?? "hello@marleymoves.co.uk"}>`;
}

/* ------------------------------------------------------- ops alert routing */

export type OpsAlertCategory = "business" | "money" | "system";

/**
 * Internal alerts route by what kind of attention they need:
 *  money    → the accounts desk (payments landed, refund decisions, overdue)
 *  system   → the engineer (Zoho/API/pipeline failures)
 *  business → the office front door (acceptances, replies, signed agreements)
 */
export function opsAlertRecipient(category: OpsAlertCategory = "business"): string {
  if (category === "money") return process.env.OPS_ALERT_EMAIL_MONEY || accountsAddress();
  if (category === "system") return process.env.OPS_ALERT_EMAIL_SYSTEM || "peter@marleymoves.co.uk";
  return process.env.OPS_ALERT_EMAIL || "hello@marleymoves.co.uk";
}

/* --------------------------------------------------- inbound forward guard */

/**
 * The unmatched-inbound catch-all must never forward our own mail back at
 * ourselves (bounce loops) or machine chatter. True = safe to forward to a
 * human mailbox. Robot detection anchors on the address's LOCAL PART — a real
 * customer at info@bounce-castles.co.uk or "Jenny Osbounce" must not be
 * swallowed by a substring match.
 *
 * Own-domain recognition here WIDENS per brand (PRD §11.7 trap 3): threading
 * `brand` through and substituting would silently stop Marley recognising its
 * own reply addresses. The Marley set below is never removed; `extraDomains`
 * (brandInboundDomains) adds the other brands'. Zero-argument calls behave
 * byte-identically to today, so sync callers stay safe by default.
 */
export function shouldForwardUnmatched(
  fromAddress: string | null | undefined,
  extraDomains: readonly string[] = [],
): boolean {
  const raw = (fromAddress ?? "").toLowerCase();
  // Pull the bare address out of "Display Name <addr>" or use the string as-is.
  const addr = (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const ours = [
    MARLEY_EMAIL_DOMAIN,
    `reply.${MARLEY_EMAIL_DOMAIN}`,
    "resend.dev",
    "amazonses.com",
    ...extraDomains.map((d) => d.trim().toLowerCase()).filter(Boolean),
  ];
  if (ours.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  return !/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|bounces)([@+._-]|$)/.test(local);
}

/**
 * The inbound/reply own-domain set from brands rows — deduped, nulls dropped
 * (the group pseudo-brand contributes nothing). Feed ALL brands rows: the two
 * columns carry DIFFERENT risk, so the filtering belongs here rather than at
 * the call site, where a future caller could silently drop it.
 *
 *  - reply_domain is a MACHINE domain: no human mailbox exists there, so
 *    counting it can never suppress a person. It counts for every row, active
 *    or not — a deactivated brand's relay address is still ours and must never
 *    be forwarded back out as a "customer". That is the loop guard.
 *
 *  - email_domain is a HUMAN staff domain, and it is only ours in that sense
 *    while we actually send from it. An inactive brand sends nothing, so adding
 *    its staff domain does not widen anything useful: recognising an address as
 *    OURS is what stops it being forwarded, so widening the own-domain set
 *    NARROWS the forward set. A real person writing in from that domain then
 *    stops reaching a human, and the ops alert calls their message automated
 *    (QA-20260826-06). PRD §11.7 trap 3 is explicit: widen to every ACTIVE
 *    brand's domains.
 *
 * Marley recognition can never narrow either way — shouldForwardUnmatched
 * hardcodes its domains and only appends these.
 */
export function brandInboundDomains(
  brands: readonly Pick<Brand, "emailDomain" | "replyDomain" | "active">[],
): string[] {
  const out = new Set<string>();
  for (const b of brands) {
    for (const d of b.active ? [b.emailDomain, b.replyDomain] : [b.replyDomain]) {
      const domain = (d ?? "").trim().toLowerCase();
      if (domain) out.add(domain);
    }
  }
  return [...out];
}

/* ------------------------------------------------------------- IO helpers */

type Sb = SupabaseClient<Database>;

export interface OwnerIdentity {
  name: string | null;
  email: string | null;
}

/** A lead owner's name + login email — only while they're ACTIVE and OFFICE
 *  (a departed member or a crew login must never front customer email). */
export async function ownerIdentity(sb: Sb, estimatorId: string | null | undefined): Promise<OwnerIdentity> {
  if (!estimatorId) return { name: null, email: null };
  const { data } = await sb
    .from("profiles")
    .select("full_name, email, role, active")
    .eq("id", estimatorId)
    .maybeSingle();
  if (!data?.active || (data.role !== "admin" && data.role !== "estimator")) {
    return { name: null, email: null };
  }
  return { name: data.full_name ?? null, email: data.email ?? null };
}

/**
 * THE canonical "whose lead is this" resolver for email identity — the same
 * rule as lib/leads/ownership.ts (explicit leads.estimator_id, else whoever is
 * assigned the earliest non-cancelled survey), so the person FRONTING a thread
 * and the person RECEIVING its replies can never diverge. `lastResortId`
 * (typically the quote's creator) is only consulted when the lead rule yields
 * nobody.
 */
export async function leadOwnerIdentity(
  sb: Sb,
  leadId: string | null | undefined,
  lastResortId?: string | null,
): Promise<OwnerIdentity> {
  let estimatorId: string | null = null;
  if (leadId) {
    const { data: lead } = await sb.from("leads").select("estimator_id").eq("id", leadId).maybeSingle();
    estimatorId = (lead?.estimator_id as string | null) ?? null;
    if (!estimatorId) {
      const { data: appt } = await sb
        .from("appointments")
        .select("estimator_id")
        .eq("lead_id", leadId)
        .eq("appt_type", "survey")
        .neq("status", "cancelled")
        .not("estimator_id", "is", null)
        .order("starts_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      estimatorId = (appt?.estimator_id as string | null) ?? null;
    }
  }
  const owner = await ownerIdentity(sb, estimatorId);
  if (owner.name || owner.email) return owner;
  return lastResortId ? ownerIdentity(sb, lastResortId) : owner;
}

/** Convenience: the From identity for a lead/quote's owner in one call. */
export async function ownerFromFor(sb: Sb, estimatorId: string | null | undefined): Promise<string> {
  const id = await ownerIdentity(sb, estimatorId);
  return ownerFrom(id.name, id.email);
}

/**
 * The tokenized panel reply relay for a lead's latest quote — so flows that
 * dispatch outside sendCommunication (certificates, one-off composes) can still
 * route replies into the panel. Undefined when the lead has no tokened quote.
 */
export async function latestReplyAddressForLead(
  sb: Sb,
  leadId: string | null | undefined,
  displayName = "Marley Moves",
): Promise<string | undefined> {
  if (!leadId) return undefined;
  const { data: q } = await sb
    .from("quotes")
    .select("accept_token")
    .eq("lead_id", leadId)
    .not("accept_token", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const token = (q?.accept_token as string | null) ?? null;
  if (!token) return undefined;
  const domain = process.env.REPLY_EMAIL_DOMAIN || "reply.marleymoves.co.uk";
  // Display name only — the ADDRESS stays on Marley's Resend-inbound reply
  // domain for every brand (machine-facing; a stub brand's reply_domain has
  // no MX yet, and a dead Reply-To silently breaks the panel thread). The
  // name gets the same hardening as every other display slot; when nothing
  // survives, the bare relay address stands alone (the webhook parses both).
  const display = sanitizeDisplayName(displayName);
  return display ? `${display} <q-${token}@${domain}>` : `q-${token}@${domain}`;
}
