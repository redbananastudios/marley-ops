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

const FROM = "Marley Moves <hello@marleymoves.co.uk>";

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

  const paragraphs = toParagraphs(v.message);
  const bodyHtml = brandedEmailHtml({
    preheader: v.subject,
    paragraphs,
  });

  const sb = await createClient();
  const result = await dispatchComm(sb, office.id, {
    channel: "email",
    to: v.to,
    from: FROM,
    subject: v.subject,
    bodyText: v.message, // drives the duplicate hash + the Comms-tab preview
    bodyHtml,
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
