/**
 * Guided-tour step definitions. Pure data (no driver.js import) so it stays
 * cheap to pull into any bundle. `tour.tsx` turns these into driver.js steps,
 * resolving each `selector` to a live element at run time — a step with no
 * selector (or whose element is absent) renders as a centred modal, which is
 * how the intro/outro beats and any off-page step behave.
 *
 * Anchors are the SIDEBAR nav items (data-tour="nav-<href>") so the office tour
 * works on any data set, plus a couple of in-page anchors on the dashboard and
 * the crew /my-jobs surface. Copy is plain UK English, short and imperative,
 * and uses example names rather than touching the database.
 */

export type TourName = "office" | "crew";

export type TourStep = {
  /** CSS selector for the element to spotlight. Omit for a centred modal. */
  selector?: string;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

/** Office walkthrough — mirrors a real job: lead → survey → quote → deposit →
 *  move day → review. Anchored to the left-rail nav so it runs on any page/data. */
const OFFICE: TourStep[] = [
  {
    title: "Welcome to Marley Ops",
    description:
      "This is your two-minute guided tour of the panel. We'll follow a job from first enquiry through to move day. You can rerun it any time from the menu.",
  },
  {
    selector: '[data-tour="nav-/leads"]',
    title: "1. Leads land here",
    description:
      "Every enquiry arrives in Leads — a website lead comes in with a sound alert and an Acknowledge banner. Open a lead, say one from Sarah in Shaftesbury, to see its timeline, comms and quotes in one place.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="dashboard-needs-action"]',
    title: "2. Your day at a glance",
    description:
      "The dashboard flags what needs attention today — new enquiries to action, unpaid deposits, unsigned contracts and fleet documents falling due. Clear these and the pipeline keeps moving.",
    side: "top",
    align: "center",
  },
  {
    selector: '[data-tour="nav-/schedule/surveys"]',
    title: "3. Book the survey",
    description:
      "Book the free home survey straight from the lead and it lands in this diary. The estimator sees it on their day, then measures up and prices the move.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/quotes"]',
    title: "4. Build the quote",
    description:
      "Quotes are built in the seven-step wizard. New quote also captures the lead in one step, so nothing's re-typed. The cubic survey lives on the quote header when you need a volume count.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/quotes"]',
    title: "5. Send it, and get paid",
    description:
      "Send the quote and the customer gets a branded email with an Accept button. When they accept, the £100 deposit invoice raises itself in Zoho — no double-keying.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/bookings"]',
    title: "6. Bookings",
    description:
      "Deposits and to-book jobs live here. One tap marks a deposit paid and the job is confirmed, ready to schedule.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/schedule/board"]',
    title: "7. Assign the crew",
    description:
      "On the Job Board you assign crew and vans per day. The capacity strip shows who's free; a clash warns you but never blocks — a van can still do two half-day jobs.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/documents"]',
    title: "8. Documents",
    description:
      "Every signed contract and completion certificate, searchable by name or reference — with a tab for accepted quotes still waiting on a signature.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/storage"]',
    title: "9. Storage",
    description:
      "Container storage lives here — sites, units, signed agreements and the recurring billing that runs itself each period.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/performance"]',
    title: "10. Performance",
    description:
      "Sales, storage and estimator numbers — how the business is actually doing, by period.",
    side: "right",
    align: "start",
  },
  {
    title: "That's the loop",
    description:
      "Lead → survey → quote → deposit → move day → review. Everything hangs off the lead, so the whole job stays together. The User manual in the menu has the full field guide.",
  },
];

/** Crew walkthrough — runs on /my-jobs. Phone-first, price-free, gets read in a
 *  van cab. Steps tolerate an empty day (no jobs assigned) via centred modals. */
const CREW: TourStep[] = [
  {
    title: "This is your day",
    description:
      "Welcome to Marley Ops. You only ever see the jobs you're assigned to — and never any prices. Here's a quick tour. You can rerun it any time from the menu.",
  },
  {
    selector: '[data-tour="crew-jobs"]',
    title: "Your jobs",
    description:
      "Your jobs, grouped by day with today first. The strip up top shows the week at a glance — a red dot means jobs are on that day.",
    side: "top",
    align: "center",
  },
  {
    selector: '[data-tour="crew-job-card"]',
    title: "Open a job",
    description:
      "Tap a job to open the full sheet: the route with one-tap directions, the inventory, and a place to add notes and photos for any damage or access issues.",
    side: "top",
    align: "center",
  },
  {
    title: "Signing off",
    description:
      "On arrival, if a job flags an unsigned contract, collect the customer's signature. When the move's done, you and the customer sign off together and they get a completion certificate by email.",
  },
  {
    selector: '[data-tour="crew-jobsheet"]',
    title: "The job sheet",
    description:
      "Tap Job sheet for a one-page printable brief — addresses, vehicles and inventory. Never any prices, so it's safe to leave in the cab.",
    side: "top",
    align: "center",
  },
  {
    title: "You're set",
    description:
      "Everything for the day lives here. If anything on a job looks wrong, call the office before you set off.",
  },
];

export const TOURS: Record<TourName, TourStep[]> = { office: OFFICE, crew: CREW };
