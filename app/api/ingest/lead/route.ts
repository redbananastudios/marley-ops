import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { landWebsiteLead } from "@/lib/leads/website-lead";
import {
  firstIssueMessage,
  ingestAuthorized,
  MAX_INGEST_BODY_BYTES,
  resolveSubmittedAt,
  websiteLeadIngestSchema,
} from "@/lib/leads/ingest";
import { decideEnquiryPushes } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import { errorContext, log } from "@/lib/log";

/**
 * Direct lead ingest — the website posts an enquiry straight into the panel.
 *
 * Replaces a pull through a world-readable Sanity dataset: the customer's name,
 * email, phone and both postcodes no longer have to sit somewhere public for
 * the panel to learn about them, and the lead lands in seconds rather than up
 * to three hours.
 *
 * The contract the caller is written against:
 *
 *   POST /api/ingest/lead
 *   Authorization: Bearer <LEAD_INGEST_SECRET>
 *   Content-Type: application/json
 *
 *   201 { ok: true,  leadId, created: true  }  the lead is now in the panel
 *   200 { ok: true,  leadId, created: false }  a retry — already landed
 *   400 { ok: false, error: "invalid_payload", detail }  will never succeed
 *   401 { ok: false, error: "unauthorized" }
 *   413 { ok: false, error: "payload_too_large" }
 *   5xx { ok: false, error: "ingest_failed" }   retry, then fall back
 *
 * The 2xx/5xx split is the load-bearing part. A 2xx is returned ONLY once the
 * row is committed, because the caller's fallback (email the office, text
 * Peter) fires on failure — so a lead reported as accepted but not stored would
 * vanish silently, with the one mechanism that would have surfaced it switched
 * off by our own answer. When in doubt this route says it failed.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reject(status: number, error: string, detail?: string) {
  return NextResponse.json(
    detail ? { ok: false, error, detail } : { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const secret = process.env.LEAD_INGEST_SECRET;
  if (!ingestAuthorized(req.headers.get("authorization"), secret)) {
    // A missing secret and a wrong secret are the same answer to the caller —
    // it learns nothing about which. They are NOT the same event to us: an
    // unconfigured secret means every real lead is being turned away, so it is
    // logged loudly rather than blending into ordinary rejected traffic.
    if (!secret?.trim()) log.warn("lead-ingest.secret_unconfigured", {});
    return reject(401, "unauthorized");
  }

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_INGEST_BODY_BYTES) {
    return reject(413, "payload_too_large");
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    log.warn("lead-ingest.body_unreadable", errorContext(err));
    return reject(400, "invalid_payload", "request body could not be read");
  }
  // Re-checked after reading: a chunked request declares no content-length.
  if (raw.length > MAX_INGEST_BODY_BYTES) return reject(413, "payload_too_large");

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(400, "invalid_payload", "body is not valid JSON");
  }

  const parsed = websiteLeadIngestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = firstIssueMessage(parsed.error);
    log.warn("lead-ingest.rejected", { detail });
    return reject(400, "invalid_payload", detail);
  }
  const input = parsed.data;

  const now = new Date();
  const when = resolveSubmittedAt(input.submittedAt, now);
  if (!when.ok) {
    log.warn("lead-ingest.rejected", { leadId: input.leadId, detail: when.reason });
    return reject(400, "invalid_payload", when.reason);
  }

  let landed: Awaited<ReturnType<typeof landWebsiteLead>>;
  try {
    landed = await landWebsiteLead(
      createAdminClient(),
      {
        externalLeadId: input.leadId,
        name: input.name,
        phone: input.phone,
        email: input.email,
        fromPostcode: input.fromPostcode,
        toPostcode: input.toPostcode,
        propertySize: input.propertySize,
        preferredDate: input.preferredDate,
        services: input.services,
        notes: input.notes,
        sourceForm: input.source,
        referrerAnswer: input.referrer,
        submittedAt: when.submittedAt,
        // Never taken from the caller. A website enquiry enters the funnel at
        // the top; the panel owns every move after that.
        status: "website_enquiry",
        attribution: input.attribution,
      },
      now,
    );
  } catch (err) {
    // The row is not committed, so this MUST read as a failure — the caller
    // retries and ultimately falls back to a human.
    log.error("lead-ingest.failed", { leadId: input.leadId, ...errorContext(err) });
    return reject(500, "ingest_failed");
  }

  if (landed.created) {
    // The office alert. Fired here rather than inside landWebsiteLead so a
    // push failure can never roll back a committed lead; sendPushForEvent is
    // itself best-effort and never throws. Uses the SAME decision the sync
    // uses, so the alarm behaves identically whichever route delivered.
    for (const event of decideEnquiryPushes(
      [{ id: landed.leadId, name: input.name, submittedAt: landed.alertSubmittedAt }],
      now,
    )) {
      await sendPushForEvent(event);
    }
  }

  log.info("lead-ingest.landed", { leadId: landed.leadId, created: landed.created });
  return NextResponse.json(
    { ok: true, leadId: landed.leadId, created: landed.created },
    { status: landed.created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
