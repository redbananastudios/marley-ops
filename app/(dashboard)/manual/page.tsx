import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ManualToc } from "@/components/manual/manual-toc";
import { JobFlowSection } from "@/components/manual/job-flow-section";
import { OfficeGuide } from "@/components/manual/office-guide";
import { CrewGuide } from "@/components/manual/crew-guide";
import { EmailsTable } from "@/components/manual/emails-table";
import { SendingEmails } from "@/components/manual/sending-emails";
import { FaqSection } from "@/components/manual/faq-section";

export const metadata: Metadata = { title: "User manual" };

/**
 * /manual — the in-app field guide for Marley Moves staff. Office (Connor,
 * Luke, any admin/estimator) and crew workflows, plus the customer email
 * reference. Deliberately short-and-scannable, not exhaustive: numbered
 * steps and small tables over long prose, matching the rest of the panel's
 * white-card / hairline-border look.
 */
export default function ManualPage() {
  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Help" title="User manual" />
      <p className="mb-6 max-w-2xl text-sm text-mist-500">
        A quick field guide to Marley Ops — how a job moves from first enquiry to a five-star review, what each
        page is for, and which emails send themselves.
      </p>

      <div className="mb-8 max-w-3xl">
        <ManualToc />
      </div>

      {/* Full-width so the pipeline diagram gets all the horizontal room it needs. */}
      <div className="mb-10">
        <JobFlowSection />
      </div>

      {/* Everything else is reading-shaped text/tables — capped for a comfortable measure. */}
      <div className="max-w-3xl space-y-10">
        <OfficeGuide />
        <CrewGuide />
        <EmailsTable />
        <SendingEmails />
        <FaqSection />
      </div>
    </main>
  );
}
