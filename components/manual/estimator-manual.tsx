import { Section, GuideCard, Steps, Bullets, Note, Kbd } from "@/components/manual/manual-ui";
import { EstimatorFlowDiagram } from "@/components/manual/estimator-flow-diagram";
import { IlluRoomScan, IlluWizardSteps } from "@/components/manual/phone-frames";

/**
 * The estimator manual — plain and practical, scoped strictly to the
 * estimator's own nav (My day, Leads, Follow-ups, Surveys, Quotes, Bookings,
 * Payments, Settings). Never references admin-only surfaces. The loop it
 * teaches: enquiry → same-day call → survey → quote → accepted, with the
 * chase engine doing the polite persistence.
 */
export function EstimatorManual() {
  return (
    <div className="max-w-3xl">
      <p className="mb-6 text-sm text-mist-500">
        Your field guide to the estimator workspace — from a fresh enquiry to an accepted quote. The office takes
        it from there.
      </p>

      <div className="mb-10 print:break-inside-avoid">
        <Section id="estimator-loop" eyebrow="Overview" title="Your loop">
          <p className="text-sm text-mist-500">
            Every job you touch runs the same line. Same-day call backs win jobs; the panel handles the chasing
            after that.
          </p>
          <EstimatorFlowDiagram />
        </Section>
      </div>

      <div className="space-y-10">
        <Section id="estimator-day" eyebrow="Daily rhythm" title="My day and Follow-ups">
          <GuideCard id="my-day" title="My day" lead="Sidebar → My day. Your morning starts here.">
            <Bullets
              items={[
                "Today's survey visits, in order, with the address and the customer's number.",
                "Follow-ups due today — overdue ones show red.",
                "Quotes awaiting a reply, and what's booked later this week.",
              ]}
            />
          </GuideCard>
          <GuideCard id="follow-ups-first" title="Call the follow-ups first" lead="Sidebar → Follow-ups.">
            <Steps
              items={[
                "Clear the due and overdue calls before anything else — a same-day call back is what wins the job.",
                "Phone-only customers (no email) get call tasks here instead of chase emails, so this list is their whole chase.",
                "Log the outcome on the lead so the next person sees where it got to.",
              ]}
            />
          </GuideCard>
        </Section>

        <Section id="estimator-surveys" eyebrow="At the property" title="Surveys and the AI room scan">
          <GuideCard id="survey-diary" title="Your survey diary" lead="Sidebar → Surveys.">
            <Bullets
              items={[
                "Booked home surveys land in this diary under your name. The customer already has the confirmation email.",
                "Free in-person survey is the norm; remote is for far-away or very small jobs.",
              ]}
            />
          </GuideCard>
          <GuideCard
            id="ai-room-scan"
            title="AI room scan — film it, don't type it"
            lead="On the survey, from the lead's survey card."
          >
            <div className="grid gap-5 sm:grid-cols-[1fr_150px]">
              <Steps
                items={[
                  "Ask for consent first — the consent sheet appears before anything records.",
                  "Film each room in one steady pass. Say out loud what's staying and what's going: \"the wardrobe comes, the bed stays\".",
                  "The scan drafts the item list room by room. Check every line — accept, fix or bin each detection before it goes anywhere.",
                  "Nothing reaches the customer or the quote until you confirm it.",
                ]}
              />
              <figure className="mx-auto w-[140px] shrink-0">
                <IlluRoomScan />
                <figcaption className="mt-2 text-center text-xs font-medium text-mist-400">
                  Narrate while you film
                </figcaption>
              </figure>
            </div>
          </GuideCard>
          <GuideCard id="cubic" title="The cubic survey — volume and the van pick" lead="On the quote header: Cubic survey.">
            <Bullets
              items={[
                "Search-first, one-tap item builder — walk the property and tap items in; each has a cubic-feet figure.",
                "The live bar shows total volume and the recommended van, with a fill percentage.",
                "On a new quote the recommendation pre-selects the vehicle; a chip on the Vehicle step offers it when you change things.",
                "“Copy customer link” lets the customer fill their own list at home — first name only, nothing sensitive.",
              ]}
            />
          </GuideCard>
        </Section>

        <Section id="estimator-quotes" eyebrow="Pricing" title="Quotes">
          <GuideCard id="wizard" title="The 7-step wizard" lead="Sidebar → Quotes → New quote, or from a lead.">
            <div className="grid gap-5 sm:grid-cols-[1fr_150px]">
              <Steps
                items={[
                  <>
                    <Kbd>New quote</Kbd> captures the customer and move details first, then drops you into the
                    builder — nothing gets typed twice.
                  </>,
                  <>
                    The steps: <strong>Customer</strong> → <strong>Job Details</strong> →{" "}
                    <strong>Vehicle &amp; Packing</strong> → <strong>Access &amp; Property</strong> →{" "}
                    <strong>Additional Charges</strong> → <strong>Items &amp; Materials</strong> →{" "}
                    <strong>Review &amp; Send</strong>.
                  </>,
                  "Step 7 shows the live total and an optional discount. Notes there are internal only — never on the customer PDF or email.",
                ]}
              />
              <figure className="mx-auto w-[140px] shrink-0">
                <IlluWizardSteps />
                <figcaption className="mt-2 text-center text-xs font-medium text-mist-400">
                  Seven steps, one flow
                </figcaption>
              </figure>
            </div>
          </GuideCard>
          <GuideCard id="send-chases" title="Send it — then let the chases work">
            <Bullets
              items={[
                "Sending emails the customer a branded quote with the PDF attached and an Accept online button.",
                "If they go quiet, up to three polite chase emails go out in your name on a set schedule.",
                "Chases stop the moment the customer replies to any Marley email, or when they accept.",
                "Accepting online raises the deposit request automatically — you don't need to do anything.",
              ]}
            />
            <Note tone="info">
              Never test-send to a real customer. Use your own email or a test lead when trying things out.
            </Note>
          </GuideCard>
        </Section>

        <Section id="estimator-after" eyebrow="After the yes" title="Bookings and money in">
          <GuideCard id="bookings" title="Bookings" lead="Sidebar → Bookings.">
            <Bullets
              items={[
                <>
                  Accepted jobs move through <strong>Awaiting deposit</strong> → <strong>To book</strong> →{" "}
                  <strong>Booked</strong>.
                </>,
                "Deposit paid is what confirms a job — nothing is scheduled until then.",
                "A bank-transfer or cash deposit is recorded with one tap from this page.",
              ]}
            />
          </GuideCard>
          <GuideCard id="payments" title="Payments" lead="Sidebar → Payments.">
            <Bullets
              items={[
                "Everything received on a day — card, transfer and cash — so you can check a customer's deposit landed before their survey or move conversation.",
              ]}
            />
          </GuideCard>
        </Section>

        <Section id="estimator-device" eyebrow="Your device" title="Quick sign-in and notifications">
          <GuideCard id="quick-signin" title="Settings → Quick sign-in and Notifications">
            <Steps
              items={[
                "Set up face or fingerprint sign-in under Quick sign-in — no password on the doorstep.",
                "Turn on notifications so a new enquiry or a paid deposit buzzes your phone.",
                "The Tour button next to the version stamp reruns your guided tour any time.",
              ]}
            />
          </GuideCard>
        </Section>
      </div>
    </div>
  );
}
