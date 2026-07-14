import { Section, GuideCard, Steps, Note, Kbd } from "@/components/manual/manual-ui";
import { CrewDayDiagram } from "@/components/manual/crew-day-diagram";

/**
 * Crew guide — the van team's view. Deliberately short: crew read this on a
 * phone, usually in the cab before or between jobs.
 */
export function CrewGuide() {
  return (
    <Section id="crew-guide" eyebrow="For the crew" title="Crew guide">
      <CrewDayDiagram />

      <GuideCard id="crew-login" title="Logging in">
        <Steps
          items={[
            <>
              A crew login goes straight to <Kbd>/my-jobs</Kbd> — never the office dashboard. You&apos;ll only ever see
              jobs you&apos;re assigned to.
            </>,
            "The day list is grouped by date, with today's jobs at the top.",
          ]}
        />
      </GuideCard>

      <GuideCard id="crew-job-page" title="The job page">
        <Steps
          items={[
            "Open a job to see the route (with a Directions link for each address), who else is on the job, the van(s), the inventory from the accepted quote, and any notes.",
            "Add your own notes and photos on site — damage, access issues, anything worth a record. These are internal only and are never sent to the customer.",
            "Survey photos taken at the original visit are also visible here for context.",
          ]}
        />
      </GuideCard>

      <GuideCard id="crew-signature" title="Collecting a signature">
        <Note tone="warn">
          If a quote was accepted online but never signed, an amber banner appears on the job page with a{" "}
          <Kbd>Collect signature now</Kbd> button — draw the signature on the tablet/phone screen before the job
          starts.
        </Note>
      </GuideCard>

      <GuideCard id="crew-signoff" title="Sign-off & completion certificate">
        <Steps
          items={[
            "At the end of the job, sign off: note any exceptions, then the customer and crew lead both sign (or record “customer absent” with a reason if they're not there).",
            "This generates a completion certificate PDF automatically, stored and emailed to the customer.",
            "Signing off never blocks or delays the move — it's the last step, not a gate.",
          ]}
        />
      </GuideCard>

      <GuideCard id="crew-jobsheet" title="Job sheet PDF">
        <Steps
          items={[
            "A one-page, price-free brief — addresses, access notes, vehicle/packing spec, inventory, and the sign-off block.",
            "Download it any time from the job page. Nothing on it ever shows a price — it's built from the same data as the office view, just with the money stripped out.",
          ]}
        />
      </GuideCard>
    </Section>
  );
}
