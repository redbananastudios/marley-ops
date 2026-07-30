import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

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
  return `Marley Moves Accounts <${accountsAddress()}>`;
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

const onDomain = (email: string | null | undefined): string | null => {
  const addr = (email ?? "").trim().toLowerCase();
  // Reject anything that could smuggle a second address or header syntax into
  // the From — the address part must be a plain local@domain token.
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(addr)) return null;
  return addr.endsWith(`@${MARLEY_EMAIL_DOMAIN}`) ? addr : null;
};

/**
 * A team member's personal sending identity: "Luke at Marley Moves <luke@…>".
 * The ADDRESS is used only when it's on the company domain; the display name
 * falls back to the address's local part, and with neither name nor a usable
 * address this degrades to the plain house identity.
 */
export function ownerFrom(name: string | null | undefined, email: string | null | undefined): string {
  const addr = onDomain(email);
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
 */
export function shouldForwardUnmatched(fromAddress: string | null | undefined): boolean {
  const raw = (fromAddress ?? "").toLowerCase();
  // Pull the bare address out of "Display Name <addr>" or use the string as-is.
  const addr = (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const ours = [MARLEY_EMAIL_DOMAIN, `reply.${MARLEY_EMAIL_DOMAIN}`, "resend.dev", "amazonses.com"];
  if (ours.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  return !/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|bounces)([@+._-]|$)/.test(local);
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
  return `Marley Moves <q-${token}@${domain}>`;
}
