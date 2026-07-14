import { Section, GuideCard, Steps, Bullets, Kbd } from "@/components/manual/manual-ui";

/**
 * Office guide — Connor / Luke / admin-estimator workflow, in the order a
 * real job moves through the panel. Labels are pulled from the live
 * components (sidebar, wizard steps, page headers) so they match exactly
 * what's on screen.
 */
export function OfficeGuide() {
  return (
    <Section id="office-guide" eyebrow="For the office" title="Office guide">
      <GuideCard id="enquiries" title="New enquiries & leads" lead="Sidebar → Leads.">
        <Steps
          items={[
            <>
              A new website enquiry sounds a repeating chime and shows a red banner at the top of the screen until
              someone clicks <Kbd>Acknowledge</Kbd>. Phone enquiries don&apos;t chime — add them yourself.
            </>,
            <>
              <Kbd>Add lead</Kbd> (top right of Leads) opens the new-lead form for anything that came in by phone,
              WhatsApp or in person.
            </>,
            <>
              Leads move through the pipeline columns as their <Kbd>status</Kbd> changes — new → contacted → survey
              booked → quoted → won/lost. Drag a card or open it to change status.
            </>,
          ]}
        />
      </GuideCard>

      <GuideCard id="survey" title="Booking a survey" lead="Sidebar → Schedule → Surveys, or from a lead's page.">
        <Steps
          items={[
            "A free in-person survey is the norm — remote is only for far-away or very small jobs.",
            "Pick the estimator on the booking. That's who owns the lead from that point (shown as the lead's estimator everywhere else in the panel).",
            "The customer gets the survey-confirmation email automatically once it's booked.",
          ]}
        />
      </GuideCard>

      <GuideCard id="quote-builder" title="Building a quote" lead="7-step wizard — Sidebar → Quotes → New quote, or from a lead.">
        <Steps
          items={[
            <>
              <Kbd>New quote</Kbd> on the Quotes page captures the customer + move details first, creates the lead
              and a draft quote together, then drops you straight into the builder — nothing gets typed twice.
            </>,
            <>
              The 7 steps: <strong>Customer</strong> → <strong>Job Details</strong> (addresses + mileage) →{" "}
              <strong>Vehicle &amp; Packing</strong> → <strong>Access &amp; Property</strong> →{" "}
              <strong>Additional Charges</strong> → <strong>Items &amp; Materials</strong> →{" "}
              <strong>Review &amp; Send</strong>.
            </>,
            <>
              On Step 3 (Vehicle &amp; Packing), <Kbd>Do a cubic survey</Kbd> opens the tablet-friendly volume
              survey — walk the property, tap items in, and it recommends the van size for you. Once a survey
              exists it shows the recommendation as a chip with a one-tap <Kbd>Use&nbsp;…</Kbd> button.
            </>,
            "Step 6 (Items & Materials) is inventory only — nothing there is charged on the quote. “Boxes” counts by 5s with the steppers; piano and other large items live in their own group.",
            "Step 7 shows the live total, the internal margin %, and an optional discount. Notes here are internal only — they never appear on the customer PDF or email.",
          ]}
        />
      </GuideCard>

      <GuideCard id="sending-quote" title="Sending the quote & what the customer sees">
        <Bullets
          items={[
            "Sending emails the quote with the fixed price attached as a PDF.",
            <>
              The customer gets a link to <code className="rounded bg-muted px-1 py-0.5 text-xs">/q/&lt;token&gt;</code> —
              a public page where they review the quote and accept online (typed-name signature, or a drawn
              signature if the crew collect it in person later).
            </>,
            "Accepting online raises a £100 deposit invoice automatically and moves the lead to provisional.",
          ]}
        />
      </GuideCard>

      <GuideCard id="deposits" title="Deposits & the Bookings page" lead="Sidebar → Sales → Bookings.">
        <Bullets
          items={[
            <>
              Bookings groups jobs into <strong>Awaiting deposit</strong> → <strong>To book</strong> (deposit paid,
              needs a diary slot) → <strong>Booked</strong>.
            </>,
            "A bank-transfer or cash deposit is recorded with one tap from this page (pick the method).",
            "Deposit paid is what flips the lead to Confirmed — nothing appears on the Job Board until then.",
          ]}
        />
      </GuideCard>

      <GuideCard id="chases" title="Automatic chase emails">
        <Bullets
          items={[
            "Sent quotes and unpaid deposits get up to 3 friendly, owner-voiced chase emails on a set schedule — signed by whoever owns the lead, not a generic “the team” signature.",
            "Chases stop the moment the customer replies to any Marley email, or once the quote is accepted / deposit is paid.",
            "A lead that never responds auto-lapses to lost after 30 days with a “no response” reason.",
          ]}
        />
      </GuideCard>

      <GuideCard id="job-board" title="Job Board — assigning crew & vans" lead="Sidebar → Schedule → Job Board.">
        <Steps
          items={[
            "A Mon–Sun week grid of every removal and survey, with a per-day capacity strip showing which crew and vans are free.",
            "Assign by opening a job's card (modal) or by dragging a resource in from the side rail.",
            "A clash warning shows when a resource is double-booked, but it never blocks the assignment — a van can cover two half-day jobs.",
            "Vans/crew required is worked out from the accepted quote, so you can see at a glance whether a job is fully staffed.",
          ]}
        />
      </GuideCard>

      <GuideCard id="balance" title="Balance invoice & payments">
        <Bullets
          items={[
            "The balance invoice is raised manually (a deliberate control — full payment before the job) from the removal appointment or the lead's payments card.",
            "It's due 24 hours before the move, unless otherwise agreed with the customer.",
            "Bank transfer, card or cash are all accepted on the balance (only the deposit is card-restricted).",
          ]}
        />
      </GuideCard>

      <GuideCard id="completion" title="Completion & review request">
        <Bullets
          items={[
            "Crew sign-off on move day (in person, or from the office if needed) raises a completion certificate PDF, emailed to the customer automatically.",
            "A review-request email follows, with a Google (or Checkatrade/Trustpilot) review link.",
            "The lead page has a Review request switch — turn it off for a customer who wasn't fully satisfied; it's switched off automatically when the crew record exceptions at sign-off.",
            "Signed evidence — contract signature + completion certificate — can't be lost by deleting a diary entry; cancel the appointment instead.",
          ]}
        />
      </GuideCard>

      <GuideCard id="documents" title="Documents register" lead="Sidebar → Sales → Documents.">
        <Bullets
          items={[
            "Every signed contract and completion certificate across every customer, searchable by name or reference.",
            "An “Unsigned contracts” tab flags accepted quotes that don't have a signature yet, sorted by move date — check this before a job goes out.",
            "A customer's full paperwork trail is also on their client page and their lead page (Overview tab).",
          ]}
        />
      </GuideCard>

      <GuideCard id="storage" title="Storage" lead="Sidebar → Operations → Storage.">
        <Steps
          items={[
            "Sites → Units → Lets. A unit's occupied/available status is worked out automatically from whether it has an open let.",
            "Assigning a client to a unit starts a let; ending the let frees the unit.",
            "Sign the storage agreement in person on the office/crew device, or send the customer a remote signing link (“Copy signing link”).",
            "Once a rate is set and the agreement is signed, billing runs on its own — a nightly job raises the next period's invoice, sends a branded email with the Zoho VAT PDF attached, and tracks paid/void status.",
            "Pause billing, edit the rate, or reopen the last let on an available unit from the Manage dialog.",
          ]}
        />
      </GuideCard>

      <GuideCard id="performance" title="Performance tabs" lead="Sidebar → Reports → Performance.">
        <Bullets
          items={[
            <><strong>Overview</strong> — estimator payroll and jobs &amp; margin.</>,
            <><strong>Sales</strong> — revenue by lens (generated / paid / projected / potential), conversion, quote funnel, per-source performance.</>,
            <><strong>Storage</strong> — occupancy, run-rate, who&apos;s in storage, stay-length stats.</>,
          ]}
        />
      </GuideCard>

      <GuideCard id="settings" title="Settings essentials" lead="Sidebar → System → Settings (admin only for editing).">
        <Bullets
          items={[
            "Team — add/remove logins and set each person's role (admin, estimator, crew). Creating a crew login auto-links their Staff & Fleet record by email.",
            "Pricing — the rate card behind every quote (vehicle prices, packing add-ons, per-mile mileage, admin fee).",
            "The general settings card holds the estimator fee, internal cost rates, the standard deposit amount, and the Google review link the review-request email uses (clear it to switch that email off).",
            "Margin calculator — a what-if sandbox for checking a job's margin before you send it.",
          ]}
        />
      </GuideCard>
    </Section>
  );
}
