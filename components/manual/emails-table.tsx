import { Section, ManualTable, Note } from "@/components/manual/manual-ui";

/**
 * The 13 customer-facing email templates, sourced from docs/email-audit.md
 * (the confirmed content + house-style audit). All 13 are addressed to the
 * customer; chases are signed by the lead's owner, not a generic signature.
 */
const ROWS: { trigger: string; email: string; note: string }[] = [
  { trigger: "Website enquiry submitted", email: "lead-auto-reply", note: "Acknowledges the enquiry — not a fixed price. We call, usually within the hour." },
  { trigger: "Survey booked", email: "survey-confirmation", note: "Date, time and estimator name; what to have ready for the visit." },
  { trigger: "Quote sent (from a survey, or direct)", email: "quote-email", note: "The fixed price, PDF attached, with the accept-online link." },
  { trigger: "Quote sent, no reply after 2 days", email: "chase-quote-1", note: "From the lead owner." },
  { trigger: "Quote sent, no reply after 5 days", email: "chase-quote-2", note: "From the lead owner." },
  { trigger: "Quote sent, no reply after 10 days", email: "chase-quote-3", note: "From the lead owner — last chase before the lead auto-lapses at 30 days." },
  { trigger: "Deposit received", email: "deposit-received", note: "Confirms the date and crew are secured." },
  { trigger: "Deposit unpaid, 1 day after acceptance", email: "chase-deposit-1", note: "From the lead owner." },
  { trigger: "Deposit unpaid, 3 days after acceptance", email: "chase-deposit-2", note: "From the lead owner." },
  { trigger: "Balance invoice raised (office, pre-move)", email: "balance-invoice", note: "Due 24 hours before the move, unless otherwise agreed." },
  { trigger: "Balance paid", email: "balance-received", note: "Nothing more to pay — confirms the move date." },
  { trigger: "Crew sign-off completed", email: "completion-certificate", note: "Certificate PDF attached." },
  { trigger: "After a completed move", email: "review-request", note: "Google (or Checkatrade/Trustpilot) review link." },
];

export function EmailsTable() {
  return (
    <Section id="emails" eyebrow="Reference" title="Emails the system sends">
      <p className="text-sm text-mist-500">
        All 13 go to the customer. Chases are personal — signed by whoever owns the lead — and stop the moment the
        customer replies to any Marley email.
      </p>
      <ManualTable
        columns={["Trigger", "Email", "What it says"]}
        rows={ROWS.map((r) => [r.trigger, <code key="e" className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.email}</code>, r.note])}
      />
      <Note tone="info">
        There are also two internal-only emails that never reach a customer: an ops alert to the office (new
        acceptance, deposit landed, a failed sync) and a night-before reminder listing tomorrow's jobs to each
        assigned crew member.
      </Note>
    </Section>
  );
}
