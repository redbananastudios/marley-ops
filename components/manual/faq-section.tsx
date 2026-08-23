import { Section, Bullets, Kbd } from "@/components/manual/manual-ui";

export function FaqSection() {
  return (
    <Section id="faq" eyebrow="Reference" title="FAQ & gotchas">
      <Bullets
        items={[
          <>
            <strong>Why can&apos;t I find the cubic survey button?</strong> It needs a lead — every quote is
            client → lead → quote, so a quote with no lead has nothing for the survey to hang off. Start from{" "}
            <Kbd>New quote</Kbd> or an existing lead.
          </>,
          <>
            <strong>Does a deposit invoice mean the job is booked?</strong> Not yet — <strong>deposit paid</strong>{" "}
            is what confirms the booking and puts the job into Schedule &amp; Allocation. A raised-but-unpaid deposit invoice
            just means the customer accepted the quote.
          </>,
          <>
            <strong>Can crew see prices?</strong> No — never. The job sheet, the /my-jobs job page, and the
            completion certificate are all built price-free by design. If a crew member needs a price changed,
            that&apos;s an office job.
          </>,
          <>
            <strong>How does a customer pay their deposit by card?</strong> On their accept page there&apos;s a
            &ldquo;Pay by card&rdquo; button (alongside bank transfer) — they pay on takepayments&apos; secure
            page and the booking confirms itself the moment it clears. To <strong>refund</strong> a card deposit,
            open the lead&apos;s <strong>Card payments</strong> card and hit Refund (admins only; it goes back to
            their card in 3–5 working days). Card payments switch on/off in <strong>Settings → Payments</strong>.
          </>,
          <>
            <strong>Never test-send to a real customer.</strong> Use your own email/phone (or a test lead) when
            trying out the compose dialog, chase emails, or anything that lands in a customer&apos;s inbox.
          </>,
          <>
            <strong>A signed contract is missing on a job that&apos;s about to go out.</strong> Check{" "}
            <strong>Documents → Unsigned contracts</strong> — it lists every accepted-but-unsigned quote by move
            date. Crew can also collect the signature on the day from the job page.
          </>,
        ]}
      />
    </Section>
  );
}
