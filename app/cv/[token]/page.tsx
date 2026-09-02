import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBusinessSettings } from "@/lib/settings";
import { sanitizeCubicLines, type CubicLine } from "@/lib/cubic-survey";
import { CubicBuilder } from "@/components/cubic/cubic-builder";
import { getBrandOrDefault } from "@/lib/brand";
import { pageTheme, pageTitle } from "@/lib/brand-page-theme";
import { MAX_CUSTOMER_SURVEY_PHOTOS } from "@/lib/survey-photos";
import { deleteCubicCustomerPhotoAction, submitCubicCustomerAction } from "./actions";
import { CustomerSurveyPhotos, type CustomerPhoto } from "./customer-photos";
import { findSurveyRowId, listCustomerPhotos, signCustomerPhotoUrls } from "./photo-store";

/**
 * /cv/<token> — customer self-fill cubic survey (/q model: the unguessable
 * token IS the credential; noindex). Shows first name only — never the
 * address or phone (iMVE's public sheet leaks all three).
 */

export const dynamic = "force-dynamic";

/** Brand-resolved (gate 16) from the LEAD this survey belongs to. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("cubic_surveys")
    .select("leads(brand)")
    .eq("share_token", token)
    .maybeSingle();
  const brandSlug = (row?.leads as { brand?: string } | null)?.brand ?? null;
  const theme = pageTheme(brandSlug ? await getBrandOrDefault(admin, brandSlug) : null);
  return { title: pageTitle(theme, "Your survey"), robots: { index: false, follow: false } };
}

export default async function CustomerCubicPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[\w-]{10,64}$/.test(token)) notFound();

  const admin = createAdminClient();
  // Deliberately NOT selecting `notes` — that column is the office's internal
  // survey commentary; the customer page reads/writes customer_notes only.
  const { data: survey } = await admin
    .from("cubic_surveys")
    .select("id, lead_id, items, customer_notes, status, updated_at")
    .eq("share_token", token)
    .maybeSingle();
  if (!survey) notFound();

  const { data: lead } = survey.lead_id
    ? await admin.from("leads").select("name, brand").eq("id", survey.lead_id).maybeSingle()
    : { data: null };
  const firstName = (lead?.name ?? "").trim().split(/\s+/)[0] || "there";
  const lines: CubicLine[] = sanitizeCubicLines(survey.items) ?? [];
  const settings = await getBusinessSettings(admin);
  // The survey belongs to a LEAD, and the lead carries the brand (PRD §3.2).
  const theme = pageTheme(lead?.brand ? await getBrandOrDefault(admin, lead.brand) : null);

  // Photos the customer has already added through this link (QA-20260827-04).
  // `survey_photos` hangs off `surveys`, not `cubic_surveys`, so this reads the
  // same row the office review page reads — and only ever READS here: the row is
  // created lazily by the upload route, so simply opening the link writes
  // nothing. A failed read is reported as a failed read, never as "no photos".
  let initialPhotos: CustomerPhoto[] = [];
  let photosUnavailable = false;
  if (survey.lead_id && survey.status !== "complete") {
    const surveyRow = await findSurveyRowId(admin, survey.lead_id);
    if (!surveyRow.ok) {
      photosUnavailable = true;
    } else if (surveyRow.id) {
      const rows = await listCustomerPhotos(admin, surveyRow.id);
      if (rows === null) {
        photosUnavailable = true;
      } else {
        const urls = await signCustomerPhotoUrls(rows.map((row) => row.storagePath));
        initialPhotos = rows.map((row) => ({ id: row.id, url: urls[row.storagePath] ?? null }));
      }
    }
  }

  return (
    // One override re-points every mm-red utility below — including the 14 in
    // CubicBuilder, which is SHARED with the office quote builder. The office
    // side renders outside this element and is therefore untouched.
    <main className="min-h-screen bg-mist-50" style={theme.rootStyle as React.CSSProperties | undefined}>
      <div className="mx-auto max-w-6xl px-5 pb-12 md:px-8">
        <div className="py-6 text-center">
          {theme.logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={theme.logoUrl} alt={theme.name} width={160} className="mx-auto" />
          ) : (
            <p
              className="font-brand text-2xl font-bold tracking-tight"
              style={{ color: theme.wordmarkColour }}
            >
              {theme.name}
            </p>
          )}
          {theme.groupLine ? (
            <p className="mt-1 text-xs font-medium text-mist-400">{theme.groupLine}</p>
          ) : null}
          <h1 className="mt-4 font-brand text-3xl font-semibold text-foreground">
            {survey.status === "complete" ? "All done — thank you." : `What's moving, ${firstName}?`}
          </h1>
          {survey.status !== "complete" ? (
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-mist-500">
              Tap everything you&apos;re taking — rough is fine, we&apos;ll confirm on the day. It helps us bring the
              right size van and crew. Questions? Call{" "}
              <a href={theme.telHref} className="font-semibold text-mm-red">
                {theme.phone}
              </a>
              .
            </p>
          ) : (
            <p className="mx-auto mt-2 max-w-xl text-sm text-mist-500">
              This survey has been finalised by our team — call us on {theme.phone} if anything has
              changed.
            </p>
          )}
        </div>

        {survey.status !== "complete" ? (
          <div className="rounded-lg border border-border bg-card px-5 pb-6 md:px-8">
            <CubicBuilder
              mode="customer"
              // The builder's two customer-facing identity strings — the submit
              // button and the confirmation card's callback number. They used to
              // be literals inside the shared builder, which put the default
              // brand's name and office number on every other brand's page,
              // under this page's own logo. Same theme, so the header and the
              // button cannot disagree.
              brand={{ name: theme.name, phone: theme.phone }}
              initialLines={lines}
              initialNotes={survey.customer_notes ?? ""}
              initialStatus={survey.status ?? "draft"}
              initialUpdatedAt={survey.updated_at}
              draftKey={`cv-${survey.id}`}
              capacities={{
                fillPct: settings.cubicFillPct,
                transitFt3: settings.cubicTransitFt3,
                lutonFt3: settings.cubicLutonFt3,
                sevenFiveTFt3: settings.cubic75tFt3,
              }}
              save={submitCubicCustomerAction.bind(null, token)}
              photoSlot={
                survey.lead_id ? (
                  <CustomerSurveyPhotos
                    uploadUrl={`/cv/${encodeURIComponent(token)}/photos`}
                    remove={deleteCubicCustomerPhotoAction.bind(null, token)}
                    initial={initialPhotos}
                    max={MAX_CUSTOMER_SURVEY_PHOTOS}
                    unavailable={photosUnavailable}
                  />
                ) : null
              }
            />
          </div>
        ) : null}

        <p className="mt-8 text-center text-xs text-mist-400">
          {theme.legalLine}
        </p>
      </div>
    </main>
  );
}
