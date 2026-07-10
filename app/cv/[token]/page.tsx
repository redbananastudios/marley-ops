import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBusinessSettings } from "@/lib/settings";
import { sanitizeCubicLines, type CubicLine } from "@/lib/cubic-survey";
import { CubicBuilder } from "@/components/cubic/cubic-builder";
import { submitCubicCustomerAction } from "./actions";

/**
 * /cv/<token> — customer self-fill cubic survey (/q model: the unguessable
 * token IS the credential; noindex). Shows first name only — never the
 * address or phone (iMVE's public sheet leaks all three).
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

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
    ? await admin.from("leads").select("name").eq("id", survey.lead_id).maybeSingle()
    : { data: null };
  const firstName = (lead?.name ?? "").trim().split(/\s+/)[0] || "there";
  const lines: CubicLine[] = sanitizeCubicLines(survey.items) ?? [];
  const settings = await getBusinessSettings(admin);

  return (
    <main className="min-h-screen bg-[#F6F5F3]">
      <div className="mx-auto max-w-6xl px-5 pb-12 md:px-8">
        <div className="py-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="https://quotes.marleymoves.co.uk/logo.png" alt="Marley Moves" width={160} className="mx-auto" />
          <h1 className="mt-4 font-display text-3xl font-semibold text-foreground">
            {survey.status === "complete" ? "All done — thank you." : `What's moving, ${firstName}?`}
          </h1>
          {survey.status !== "complete" ? (
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-mist-500">
              Tap everything you&apos;re taking — rough is fine, we&apos;ll confirm on the day. It helps us bring the
              right size van and crew. Questions? Call{" "}
              <a href="tel:01747637070" className="font-semibold text-mm-red">
                01747 637070
              </a>
              .
            </p>
          ) : (
            <p className="mx-auto mt-2 max-w-xl text-sm text-mist-500">
              This survey has been finalised by our team — call us on 01747 637070 if anything has changed.
            </p>
          )}
        </div>

        {survey.status !== "complete" ? (
          <div className="rounded-lg border border-[#E8E4DD] bg-white px-5 pb-6 md:px-8">
            <CubicBuilder
              mode="customer"
              customerName={firstName}
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
            />
          </div>
        ) : null}

        <p className="mt-8 text-center text-xs text-mist-400">
          Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7
        </p>
      </div>
    </main>
  );
}
