"use server";

/**
 * Ad-hoc customer email — an operator composes a one-off message in the panel
 * (the "Email" contact buttons + the clients list). Office-only (crew are
 * denied); the copy is wrapped in the branded shell + standard footer and sent
 * through the shared dispatcher, so it lands in the Comms log with the same
 * content-hash duplicate guard as every other customer email.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createClient } from "@/lib/supabase/server";
import { dispatchComm, type DispatchCommResult } from "@/lib/comms/dispatch";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { helloFromFor, ownerFrom } from "@/lib/comms/sender";
import { DEFAULT_BRAND, getBrandOrDefault } from "@/lib/brand";
import { replyAddressFor } from "@/lib/quote/chase";

const schema = z.object({
  to: z.string().trim().email("Enter a valid email address"),
  subject: z.string().trim().min(1, "Add a subject").max(150, "Subject is too long"),
  message: z.string().trim().min(1, "Write a message").max(5000, "Message is too long"),
  leadId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  override: z.boolean().optional(),
  overrideReason: z.string().trim().max(300).optional(),
});

export type SendAdHocEmailInput = z.infer<typeof schema>;

/** Plain text → paragraphs: split on blank lines, keeping single newlines inside
 *  a paragraph (branded-shell turns those into <br>). */
function toParagraphs(message: string): string[] {
  return message
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export async function sendAdHocEmailAction(input: SendAdHocEmailInput): Promise<DispatchCommResult> {
  // Office-only: crew never send customer comms.
  const office = await requireOfficeProfile();
  if (!office) return { ok: false, error: "Not authorised." };

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;

  const sb = await createClient();

  // The record's brand, resolved server-side from the lead (falling back to
  // the client's latest lead is overkill here — an unlinked compose is a
  // marley send, exactly as today). Multi-brand PRD §3.5.
  let brandSlug: string | null = null;
  if (v.leadId) {
    const { data: l } = await sb.from("leads").select("brand").eq("id", v.leadId).maybeSingle();
    brandSlug = (l?.brand as string | null) ?? null;
  }
  const brand = await getBrandOrDefault(sb, brandSlug ?? DEFAULT_BRAND);

  const paragraphs = toParagraphs(v.message);
  const bodyHtml = brandedEmailHtml({
    preheader: v.subject,
    paragraphs,
    brand,
  });

  // A composed one-off routes replies back through the panel relay when the
  // lead has a quote token (chase pause + Comms log), like every other
  // lead-linked email; without one, replies go to the sender's own mailbox.
  let replyTo: string | undefined;
  if (v.leadId) {
    const { data: q } = await sb
      .from("quotes")
      .select("accept_token")
      .eq("lead_id", v.leadId)
      .not("accept_token", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (q?.accept_token) replyTo = replyAddressFor(q.accept_token, brand.name);
  }
  // No relay token → replies go to the composer's own company mailbox (their
  // From address), keeping the conversation with the person who wrote it.
  if (!replyTo && office.email?.toLowerCase().endsWith("@marleymoves.co.uk")) {
    replyTo = office.email;
  }

  const result = await dispatchComm(sb, office.id, {
    channel: "email",
    to: v.to,
    // The person writing it signs it — the composer sends as themselves.
    // Composer identities are Marley logins, so a non-default brand's mail
    // fronts its own door instead (PRD §3.5).
    from: brand.slug === DEFAULT_BRAND ? ownerFrom(office.fullName, office.email) : helloFromFor(brand),
    replyTo,
    subject: v.subject,
    bodyText: v.message, // drives the duplicate hash + the Comms-tab preview
    bodyHtml,
    brand,
    leadId: v.leadId,
    clientId: v.clientId,
    override: v.override,
    overrideReason: v.overrideReason,
  });

  if ("ok" in result && result.ok) {
    if (v.leadId) revalidatePath(`/leads/${v.leadId}`);
    if (v.clientId) revalidatePath(`/clients/${v.clientId}`);
  }
  return result;
}
