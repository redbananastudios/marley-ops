"use server";

/**
 * Crew-device signature actions (Peter, 2026-07-10):
 *  - signContractInPersonAction — the doorstep fallback when the contract was
 *    never signed remotely: same acknowledgment set + a drawn signature, so
 *    the record is identical to the /q path except channel='in_person'.
 *  - completeJobAction — the on-site completion sign-off: customer + crew
 *    signatures + exceptions, certificate PDF stored + emailed to the
 *    customer, appointment marked completed. Idempotent per appointment.
 *
 * Runs on the ADMIN client after auth (crew are RLS-blocked from quotes but
 * legitimately collect these). Nothing price-shaped crosses the wire.
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import {
  buildCompletionEmailHtml,
  completionEmailSubject,
  completionEmailText,
  completionEmailVariables,
  type CompletionEmailInput,
} from "@/lib/comms/completion-email";
import { allAcksConfirmed, isValidSignatureDataUri, normalizeAcks, TERMS_VERSION } from "@/lib/signatures";
import { exceptionsWarrantReviewSuppression } from "@/lib/comms/review-suppression";

async function requireActiveProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb.from("profiles").select("id, active, full_name, email").eq("id", user.id).single();
  if (!prof?.active) return null;
  return prof;
}

/* ------------------------------------------------- in-person contract */

export async function signContractInPersonAction(
  appointmentId: string,
  input: { signerName: string; signatureDataUri: string; acks: Record<string, boolean> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const name = input.signerName.trim();
  if (name.length < 2) return { ok: false, error: "Type the customer's full name." };
  if (!allAcksConfirmed(input.acks)) return { ok: false, error: "Tick each confirmation with the customer first." };
  if (!isValidSignatureDataUri(input.signatureDataUri)) {
    return { ok: false, error: "The signature didn't come through — ask them to sign again." };
  }

  const admin = createAdminClient();
  const { data: appt } = await admin.from("appointments").select("id, lead_id").eq("id", appointmentId).single();
  if (!appt?.lead_id) return { ok: false, error: "This job has no linked lead." };

  const { data: quote } = await admin
    .from("quotes")
    .select("id, quote_ref, client_id")
    .eq("lead_id", appt.lead_id)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!quote) return { ok: false, error: "No accepted quote on this job — call the office." };

  const { error } = await admin.from("signatures").insert({
    kind: "contract",
    quote_id: quote.id,
    lead_id: appt.lead_id,
    client_id: quote.client_id,
    signer_name: name,
    signature_data: input.signatureDataUri,
    method: "drawn",
    channel: "in_person",
    acknowledgments: normalizeAcks(input.acks),
    terms_version: TERMS_VERSION,
    collected_by: prof.id,
  } as never);
  if (error) {
    // Unique index: someone else (or a replay) already collected it — that's a success state.
    if (error.code === "23505") return { ok: true };
    return { ok: false, error: "Could not save the signature — try again." };
  }

  await admin.from("activities").insert({
    lead_id: appt.lead_id,
    client_id: quote.client_id,
    actor_id: prof.id,
    type: "note",
    summary: `Contract signed in person by "${name}" (collected on the crew device, quote ${quote.quote_ref})`,
    meta: { quote_id: quote.id, via: "crew_device" },
  });

  return { ok: true };
}

/* ------------------------------------------------- completion sign-off */

const completionSchema = z.object({
  exceptions: z.string().max(2000).default(""),
  customerAbsent: z.boolean().default(false),
  customerName: z.string().max(120).default(""),
  customerSignature: z.string().nullable().default(null),
  absentReason: z.string().max(500).default(""),
  crewName: z.string().min(2).max(120),
  crewSignature: z.string(),
  /** The certificate PDF built on the crew device (base64, no data: prefix). */
  certificatePdfBase64: z.string().max(4_000_000).nullable().default(null),
});

export type CompletionInput = z.input<typeof completionSchema>;

export async function completeJobAction(
  appointmentId: string,
  raw: CompletionInput,
): Promise<
  | { ok: true; emailed: boolean; emailNote?: string; alreadyCompleted?: boolean }
  | { ok: false; error: string }
> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Something in the form didn't come through — try again." };
  const v = parsed.data;

  if (!isValidSignatureDataUri(v.crewSignature)) {
    return { ok: false, error: "The crew signature didn't come through — sign again." };
  }
  if (v.customerAbsent) {
    if (v.absentReason.trim().length < 3) {
      return { ok: false, error: "Say briefly why the customer couldn't sign — it goes on the record." };
    }
  } else {
    if (v.customerName.trim().length < 2) return { ok: false, error: "Type the customer's name." };
    if (!isValidSignatureDataUri(v.customerSignature)) {
      return { ok: false, error: "The customer's signature didn't come through — ask them to sign again." };
    }
  }

  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select("id, lead_id, starts_at, appt_type, status")
    .eq("id", appointmentId)
    .single();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.appt_type !== "removal") return { ok: false, error: "Completion sign-off is for removal jobs." };

  const { data: lead } = appt.lead_id
    ? await admin.from("leads").select("id, name, email, client_id").eq("id", appt.lead_id).single()
    : { data: null };

  // Link the signed-in user to their staff record for the completion row.
  const { data: staffRow } = await admin
    .from("staff")
    .select("id")
    .eq("profile_id", prof.id)
    .eq("is_active", true)
    .maybeSingle();

  const { data: completion, error: insErr } = await admin
    .from("job_completions")
    .insert({
      appointment_id: appointmentId,
      lead_id: appt.lead_id,
      client_id: lead?.client_id ?? null,
      customer_name: v.customerAbsent ? null : v.customerName.trim(),
      customer_signature: v.customerAbsent ? null : v.customerSignature,
      customer_absent: v.customerAbsent,
      absent_reason: v.customerAbsent ? v.absentReason.trim() : null,
      exceptions: v.exceptions.trim(),
      crew_staff_id: staffRow?.id ?? null,
      crew_name: v.crewName.trim(),
      crew_signature: v.crewSignature,
      completed_by: prof.id,
    } as never)
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") return { ok: true, emailed: false, alreadyCompleted: true };
    return { ok: false, error: "Could not record the completion — try again." };
  }

  // The diary reflects reality; lead-status transitions stay with the chase
  // engine (auto-complete + review request once the money is settled).
  await admin.from("appointments").update({ status: "completed" } as never).eq("id", appointmentId);

  // Store the certificate (fail-soft — the signed record above is the evidence).
  let certPath: string | null = null;
  if (v.certificatePdfBase64) {
    try {
      const buf = Buffer.from(v.certificatePdfBase64, "base64");
      if (buf.length > 0 && buf.subarray(0, 5).toString() === "%PDF-") {
        certPath = `completions/${appointmentId}.pdf`;
        const { error: upErr } = await admin.storage
          .from("job-docs")
          .upload(certPath, buf, { contentType: "application/pdf", upsert: true });
        if (upErr) certPath = null;
      }
    } catch {
      certPath = null;
    }
  }

  const exceptionsNote = v.exceptions.trim();
  await admin.from("activities").insert({
    lead_id: appt.lead_id,
    client_id: lead?.client_id ?? null,
    actor_id: prof.id,
    type: "status_change",
    summary: v.customerAbsent
      ? `Job completed on site — customer not present (${v.absentReason.trim()}), signed by crew lead ${v.crewName.trim()}${exceptionsNote ? ` · exceptions: ${exceptionsNote}` : ""}`
      : `Job completed on site — signed by "${v.customerName.trim()}" + crew lead ${v.crewName.trim()}${exceptionsNote ? ` · exceptions: ${exceptionsNote}` : " · nothing to report"}`,
    meta: { appointment_id: appointmentId, completion_id: completion.id, exceptions: exceptionsNote || null },
  });

  // Exceptions recorded at sign-off → the customer wasn't fully satisfied.
  // Auto-switch OFF the post-move review ask (reversible via the office toggle).
  // This covers BOTH the present and customer-absent paths: absence alone (empty
  // exceptions) never suppresses — only a real exceptions note does.
  if (appt.lead_id && exceptionsWarrantReviewSuppression(v.exceptions)) {
    await admin.from("leads").update({ review_suppressed: true } as never).eq("id", appt.lead_id);
    await admin.from("activities").insert({
      lead_id: appt.lead_id,
      client_id: lead?.client_id ?? null,
      actor_id: prof.id,
      type: "note",
      summary: "Review request switched off automatically — exceptions recorded at sign-off",
      meta: { appointment_id: appointmentId, completion_id: completion.id, auto: true },
    });
  }

  // Email the certificate — fail-soft; completion stands regardless.
  let emailed = false;
  let emailNote: string | undefined;
  if (!lead?.email) {
    emailNote = "No email on the customer's record — certificate saved, not emailed.";
  } else {
    const moveDay = appt.starts_at ? appt.starts_at.slice(0, 10) : null;
    const emailInput: CompletionEmailInput = {
      firstName: (lead.name ?? "").trim().split(/\s+/)[0] || "there",
      moveDateLabel: moveDay
        ? new Date(`${moveDay}T00:00:00Z`).toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })
        : "your move date",
      hasExceptions: exceptionsNote.length > 0,
      exceptions: exceptionsNote,
      customerAbsent: v.customerAbsent,
    };
    const templateId = process.env.RESEND_TEMPLATE_COMPLETION_CERT;
    const res = await dispatchComm(admin, prof.id, {
      channel: "email",
      to: lead.email,
      subject: completionEmailSubject(emailInput),
      bodyText: completionEmailText(emailInput),
      ...(templateId
        ? { template: { id: templateId, variables: completionEmailVariables(emailInput) } }
        : { bodyHtml: buildCompletionEmailHtml(emailInput) }),
      attachmentBase64: v.certificatePdfBase64 ?? undefined,
      attachmentName: v.certificatePdfBase64 ? "marley-moves-completion-certificate.pdf" : undefined,
      from: "Marley Moves <quotes@marleymoves.co.uk>",
      replyTo: "hello@marleymoves.co.uk",
      leadId: appt.lead_id ?? undefined,
      clientId: lead.client_id ?? undefined,
    });
    emailed = "ok" in res && res.ok === true;
    if (!emailed) {
      emailNote =
        "duplicate" in res
          ? "Certificate already emailed earlier."
          : "Certificate saved but the email failed — the office can resend it.";
      if (!("duplicate" in res)) {
        await sendOpsAlert("Completion certificate email FAILED", [
          `Job completion recorded for <strong>${lead.name ?? "customer"}</strong> but the certificate email failed.`,
          `Check Comms and resend manually.`,
        ]);
      }
    }
  }

  if (emailed || certPath) {
    await admin
      .from("job_completions")
      .update({
        certificate_path: certPath,
        certificate_emailed_at: emailed ? new Date().toISOString() : null,
      } as never)
      .eq("id", completion.id);
  }

  return { ok: true, emailed, emailNote };
}

/* ------------------------------------------------- certificate resend (office) */

/** Resend the stored completion certificate — the recovery path when the
 *  original email failed/bounced or the customer lost it. Sends the SAME
 *  stored PDF (evidence never regenerates) with the duplicate-guard
 *  deliberately overridden (a resend is identical content by design). */
export async function resendCertificateAction(
  completionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(completionId).success) return { ok: false, error: "Invalid completion" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const { data: comp } = await admin
    .from("job_completions")
    .select("id, lead_id, customer_absent, exceptions, certificate_path, appointment_id")
    .eq("id", completionId)
    .single();
  if (!comp) return { ok: false, error: "Completion record not found." };
  if (!comp.certificate_path) return { ok: false, error: "No stored certificate PDF for this completion." };

  const { data: lead } = comp.lead_id
    ? await admin.from("leads").select("id, name, email, client_id").eq("id", comp.lead_id).single()
    : { data: null };
  if (!lead?.email) return { ok: false, error: "No email address on the customer's record." };

  const { data: file, error: dlErr } = await admin.storage.from("job-docs").download(comp.certificate_path);
  if (dlErr || !file) return { ok: false, error: "Could not read the stored certificate." };
  const pdfB64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  const { data: appt } = await admin
    .from("appointments")
    .select("starts_at")
    .eq("id", comp.appointment_id)
    .maybeSingle();
  const moveDay = appt?.starts_at ? appt.starts_at.slice(0, 10) : null;
  const exceptionsNote = (comp.exceptions ?? "").trim();
  const emailInput: CompletionEmailInput = {
    firstName: (lead.name ?? "").trim().split(/\s+/)[0] || "there",
    moveDateLabel: moveDay
      ? new Date(`${moveDay}T00:00:00Z`).toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "your move date",
    hasExceptions: exceptionsNote.length > 0,
    exceptions: exceptionsNote,
    customerAbsent: comp.customer_absent,
  };
  const templateId = process.env.RESEND_TEMPLATE_COMPLETION_CERT;
  const res = await dispatchComm(admin, prof.id, {
    channel: "email",
    to: lead.email,
    subject: completionEmailSubject(emailInput),
    bodyText: completionEmailText(emailInput),
    ...(templateId
      ? { template: { id: templateId, variables: completionEmailVariables(emailInput) } }
      : { bodyHtml: buildCompletionEmailHtml(emailInput) }),
    attachmentBase64: pdfB64,
    attachmentName: "marley-moves-completion-certificate.pdf",
    from: "Marley Moves <quotes@marleymoves.co.uk>",
    replyTo: "hello@marleymoves.co.uk",
    leadId: lead.id,
    clientId: lead.client_id ?? undefined,
    override: true,
    overrideReason: "Certificate resend from the office",
  });
  if (!("ok" in res && res.ok)) {
    return { ok: false, error: "duplicate" in res ? "Send blocked as duplicate — try again." : res.error };
  }
  await admin
    .from("job_completions")
    .update({ certificate_emailed_at: new Date().toISOString() } as never)
    .eq("id", comp.id);
  return { ok: true };
}
