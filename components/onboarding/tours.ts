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
 *
 * Tour-fatigue rule: keep each tour a "two-minute tour" — when the app grows,
 * reword or merge steps before adding new ones (refreshed 2026-07-16 to cover
 * Payments/Finance, Customers incl. Content, Claims, and the crew capture +
 * device steps).
 */

export type TourName = "office" | "estimator" | "crew";

export type TourStep = {
  /** CSS selector for the element to spotlight. Omit for a centred modal. */
  selector?: string;
  title: string;
  description: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

/** Office walkthrough — mirrors a real job: lead → survey → quote → deposit →
 *  move day → the money and the records. Anchored to the left-rail nav so it
 *  runs on any page/data. */
const OFFICE: TourStep[] = [
  {
    title: "Welcome to Marley Ops",
    description:
      "This is your two-minute guided tour of the panel. We'll follow a job from first enquiry through to move day and the money. You can rerun it any time from the menu.",
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
      "The dashboard flags what needs attention today — new enquiries to action, unpaid deposits, unsigned contracts, open claims and fleet documents falling due. Clear these and the pipeline keeps moving.",
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
    title: "4. Quote it, send it",
    description:
      "Quotes are built in the seven-step wizard — New quote also captures the lead in one step. Send it and the customer gets a branded email with an Accept button; accepting raises the £100 deposit invoice on its own.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/bookings"]',
    title: "5. Bookings",
    description:
      "Deposits and to-book jobs live here. One tap marks a deposit paid and the job is confirmed, ready to schedule.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/payments"]',
    title: "6. Money in, and what you owe",
    description:
      "Payments shows everything received on a day — card, bank transfer and cash, with the bank feed suggesting matches. Next door, Invoices & VAT shows what's billed and the VAT owed for the month and quarter.",
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
    selector: '[data-tour="nav-/clients"]',
    title: "8. Customers",
    description:
      "The customer's whole file: Clients, their signed paperwork in Documents, and Content — the photos, videos and voice notes crew capture on jobs, waiting for your review before marketing can touch them.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/claims"]',
    title: "9. Claims",
    description:
      "A damage note at crew sign-off opens a claim here automatically — with the status trail, the customer's 7-day window and a ready-made evidence pack for the insurer.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/storage"]',
    title: "10. Storage",
    description:
      "Container storage lives here — sites, units, signed agreements and the recurring billing that runs itself each period.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/performance"]',
    title: "11. Performance",
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

/** Estimator walkthrough — scoped strictly to the estimator nav (My day, Leads,
 *  Follow-ups, Surveys, Quotes, Bookings, Payments, Settings, User manual).
 *  Never references admin-only surfaces (Job Board, Documents, Claims, Storage,
 *  Performance) — an estimator can't see them, so the tour must not either. */
const ESTIMATOR: TourStep[] = [
  {
    title: "Welcome to Marley Ops",
    description:
      "This is your two-minute tour of the estimator workspace — from a fresh enquiry to a sent quote. You can rerun it any time from the menu.",
  },
  {
    selector: '[data-tour="nav-/estimator"]',
    title: "1. My day",
    description:
      "Your day starts here — today's survey visits and anything waiting on you, in one list.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/leads"]',
    title: "2. Leads",
    description:
      "Every enquiry lands in Leads — a website lead arrives with a sound alert and an Acknowledge banner. Open a lead, say one from Sarah in Shaftesbury, to see its timeline, comms and quotes in one place.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/follow-ups"]',
    title: "3. Follow-ups",
    description:
      "Calls and check-ins that are due or overdue. Clear these first thing — a same-day call back is what wins the job.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/schedule/surveys"]',
    title: "4. Your survey diary",
    description:
      "Booked home surveys land in this diary. At the property you can use AI room scan — film each room, narrate what's staying, and it drafts the inventory for you to check.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/quotes"]',
    title: "5. Build the quote",
    description:
      "Quotes are built in the seven-step wizard — New quote also captures the lead in one step. The cubic survey sits on the quote header when you need a volume count and a van recommendation.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/quotes"]',
    title: "6. Send it",
    description:
      "Send the quote and the customer gets a branded email with an Accept button. If they go quiet, polite chase emails go out in your name automatically — and stop the moment they reply.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/bookings"]',
    title: "7. Bookings",
    description:
      "Watch the deposit land here — accepted jobs move through Awaiting deposit to Booked, and deposit paid is what confirms the job.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="nav-/settings"]',
    title: "8. Your device",
    description:
      "Settings holds Quick sign-in — Face ID or a fingerprint instead of a password — and Notifications, so a new enquiry or a paid deposit buzzes your phone.",
    side: "right",
    align: "start",
  },
  {
    title: "That's your loop",
    description:
      "Enquiry → survey → quote → accepted. The office takes it from there. The User manual in the menu has the full field guide.",
  },
];

/** Crew walkthrough — runs on /my-jobs. Phone-first, price-free, gets read in a
 *  van cab. Steps tolerate an empty day (no jobs assigned) via centred modals. */
const CREW: TourStep[] = [
  {
    title: "This is your day",
    description:
      "Welcome to Marley Ops. You only ever see the jobs you're assigned to — and never any prices. Here's a quick tour. You can rerun it any time.",
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
      "Tap a job to open the full sheet: the route with one-tap directions, what you're moving, and who's on the job with you.",
    side: "top",
    align: "center",
  },
  {
    title: "Damage or a problem?",
    description:
      "Tap the red camera button on a job. Photos, notes and voice notes live on the job — the office sees them straight away. Never argue on site: record it, then call the office.",
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
    selector: '[data-tour="crew-device"]',
    title: "Alerts and easy sign-in",
    description:
      "Turn on job alerts so your phone buzzes when you're given a job, and set up face or fingerprint sign-in. The User manual here shows every step with pictures.",
    side: "top",
    align: "center",
  },
  {
    title: "You're set",
    description:
      "Everything for the day lives here. If anything on a job looks wrong, call the office before you set off.",
  },
];

export const TOURS: Record<TourName, TourStep[]> = { office: OFFICE, estimator: ESTIMATOR, crew: CREW };

/** The tour a dashboard role gets: estimators have their own scoped tour;
 *  admins get the full office walkthrough. (Crew mount theirs on /my-jobs.) */
export const tourForRole = (role: string): TourName => (role === "estimator" ? "estimator" : "office");
