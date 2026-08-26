/**
 * Post-move review ask — SERVER ONLY. One email per lead, ever
 * (leads.review_requested_at is the claim), gated on the Google review URL in
 * Settings. Fired when a lead reaches COMPLETED: by the daily cron's
 * auto-complete pass, or by staff marking it completed by hand.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the lead's brand drives the
 * copy, the From identity and — critically — the DESTINATION. A non-default
 * brand with no brands.review_url gets NO review email at all (skip is
 * logged, never silent) rather than borrowing Marley's Google listing from
 * Settings. Marley's flow is unchanged, including the Settings kill switch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBusinessSettings } from "@/lib/settings";
import { dispatchComm } from "@/lib/comms/dispatch";
import { buildReviewRequestEmailHtml } from "@/lib/comms/payment-email";
import { replyAddressFor } from "@/lib/quote/chase";
import { helloFromFor, leadOwnerIdentity, ownerFrom } from "@/lib/comms/sender";
import { selectBrandReviewLink } from "@/lib/comms/review-platform";
import { DEFAULT_BRAND, getBrandOrDefault } from "@/lib/brand";
import { emailTheme } from "@/lib/comms/email-brand";
import { templateIdFor } from "@/lib/comms/template-id";
import { log } from "@/lib/log";

type Sb = SupabaseClient<Database>;

export async function sendReviewRequest(
  sb: Sb,
  leadId: string,
  actorId: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const settings = await getBusinessSettings(sb);
  const googleUrl = settings.googleReviewUrl?.trim() ?? "";

  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id, estimator_id, name, email, entry_channel, review_requested_at, review_suppressed, brand")
    .eq("id", leadId)
    .maybeSingle();
  const brand = await getBrandOrDefault(sb, (lead?.brand as string | null) ?? DEFAULT_BRAND);

  // The Settings field is MARLEY's review-ask kill switch — the Settings UI
  // has always said "clear it to switch the review ask off", so a cleared
  // value sends NOTHING rather than silently falling back to a hardcoded
  // link. Bails before the claim, so switching it back on can still send
  // later. It governs the default brand only: another brand's ask lives or
  // dies on its own brands.review_url below.
  if (brand.slug === DEFAULT_BRAND && !googleUrl) {
    return { sent: false, reason: "review ask switched off in Settings" };
  }

  if (!lead?.email) return { sent: false, reason: "no email on the lead" };
  if (lead.review_requested_at) return { sent: false, reason: "already asked" };
  // Office/crew switched the review ask off for this job (customer wasn't fully
  // satisfied) — bail BEFORE the claim so a re-enable can still send later.
  if (lead.review_suppressed) return { sent: false, reason: "review request switched off for this job" };

  // Ask where this customer can actually leave the review: a Checkatrade lead
  // on Checkatrade (feeds the profile they found us on), a Google-mailbox
  // customer on Google (a Google review needs a Google account), everyone
  // else on Trustpilot (no account barrier) — all MARLEY destinations, so a
  // non-default brand routes ONLY to its own review URL. Null = this brand
  // has nowhere to be reviewed yet: skip explicitly and log it (the standing
  // rule — never fall back to Marley's listing, never skip silently). Bails
  // before the claim, so setting the brand's URL later can still send.
  const review = selectBrandReviewLink(brand, DEFAULT_BRAND, lead.email, lead.entry_channel, googleUrl);
  if (!review) {
    log.info("review_request.skipped", {
      leadId,
      brand: brand.slug,
      reason: "brand has no review_url — no review ask for this brand",
    });
    return { sent: false, reason: `review ask off for ${brand.name}: no review URL on the brand` };
  }

  // Claim first — a cron/staff race must never double-send.
  const { data: won } = await sb
    .from("leads")
    .update({ review_requested_at: new Date().toISOString() } as never)
    .eq("id", leadId)
    .is("review_requested_at", null)
    .select("id");
  if (!won?.length) return { sent: false, reason: "already asked" };

  // Route any reply back into the panel via the lead's latest quote token.
  const { data: q } = await sb
    .from("quotes")
    .select("accept_token")
    .eq("lead_id", leadId)
    .not("accept_token", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const token = (q?.accept_token as string | null) ?? null;

  const first = (lead.name ?? "").trim().split(/\s+/)[0] || "there";

  const owner = await leadOwnerIdentity(sb, leadId, lead.estimator_id);
  // A personal ask converts better, but the personal identities are all
  // Marley-domain logins — a non-default brand sends from its own front door
  // so a Pitmans customer never sees a Marley From.
  const reviewFrom =
    brand.slug === DEFAULT_BRAND ? ownerFrom(owner.name, owner.email) : helloFromFor(brand);

  const t = emailTheme(brand);
  const crew = t.isDefault ? "Connor and the crew" : "the team";

  // Prefer the published Resend template (copy editable in the dashboard, no
  // deploy); the in-repo HTML is the fallback when the id isn't set. A
  // non-default brand resolves its OWN hosted set via templateIdFor — never
  // Marley's env template (§11.7 trap 4).
  const templateId = templateIdFor(brand, "RESEND_TEMPLATE_REVIEW_REQUEST");
  const res = await dispatchComm(sb, actorId, {
    channel: "email",
    to: lead.email,
    subject: `How did we do, ${first}?`,
    bodyText: `Thanks for moving with ${t.name}. If ${crew} looked after you, a quick ${review.platform} review makes a real difference to us: ${review.url}. If anything wasn't right, reply to this email or call the team on ${t.phone} first.`,
    // bodyHtml rides alongside the template as the rendered fallback (oversize
    // guard + SMTP outage transport) — the template wins when usable.
    bodyHtml: buildReviewRequestEmailHtml({ firstName: lead.name, reviewUrl: review.url, platform: review.platform, brand }),
    ...(templateId
      ? {
          template: {
            id: templateId,
            variables: { CUSTOMER_FIRST_NAME: first, REVIEW_PLATFORM: review.platform, REVIEW_URL: review.url },
          },
        }
      : {}),
    replyTo: token ? replyAddressFor(token) : undefined,
    from: reviewFrom,
    leadId,
    clientId: lead.client_id ?? undefined,
    brand,
  });

  if (!("ok" in res && res.ok)) {
    // Send failed → release the claim so the next completion pass retries.
    if ("ok" in res && !res.ok) {
      await sb.from("leads").update({ review_requested_at: null } as never).eq("id", leadId);
      return { sent: false, reason: res.error };
    }
    return { sent: false, reason: "duplicate" };
  }
  return { sent: true };
}
