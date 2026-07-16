import { ManualToc } from "@/components/manual/manual-toc";
import { JobFlowSection } from "@/components/manual/job-flow-section";
import { OfficeGuide } from "@/components/manual/office-guide";
import { EmailsTable } from "@/components/manual/emails-table";
import { SendingEmails } from "@/components/manual/sending-emails";
import { FaqSection } from "@/components/manual/faq-section";

/**
 * The office manual — Connor / any admin. The full field guide: pipeline
 * diagram, the per-page office guide, the customer-email reference and the
 * FAQ. Estimators and crew get their own role-scoped manuals; admins can
 * preview those with the switcher on /manual.
 */
export function OfficeManual() {
  return (
    <>
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
        <EmailsTable />
        <SendingEmails />
        <FaqSection />
      </div>
    </>
  );
}
