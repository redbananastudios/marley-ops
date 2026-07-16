/**
 * The automation registry — the single source of truth for what scheduled jobs
 * exist, on what cadence, and how fresh a run should be before we call it
 * "overdue". Keep the `slug` in step with the string passed to runCron() in each
 * route and with the `path` in vercel.json. The /automations page reads this to
 * show every automation, its schedule, and its health.
 *
 * Times are UTC (Vercel Cron runs in UTC). `maxAgeMins` = if the newest
 * successful run is older than this, flag the job as overdue (a cheap "is this
 * automation actually firing?" signal for production monitoring).
 */
export interface CronJobMeta {
  slug: string;
  label: string;
  schedule: string; // raw cron expression (as in vercel.json)
  cadence: string; // human-readable, UTC
  description: string;
  maxAgeMins: number;
  endpoint: string; // office-session GET that fires the job (Run now + cron-hit.sh)
}

export const CRON_JOBS: CronJobMeta[] = [
  {
    slug: "zoho-deposits",
    label: "Payment watcher",
    schedule: "*/15 * * * *",
    cadence: "Every 15 minutes",
    description: "Polls Zoho for deposit + balance payments and confirms bookings as money lands.",
    maxAgeMins: 45,
    endpoint: "/api/cron/zoho-deposits",
  },
  {
    slug: "ai-jobs",
    label: "AI survey worker",
    schedule: "*/2 * * * *",
    cadence: "Every 2 minutes",
    description: "Drains the queue of AI room-scan analysis jobs from the cubic survey.",
    maxAgeMins: 15,
    endpoint: "/api/cron/ai-jobs",
  },
  {
    slug: "sanity-leads-sync",
    label: "Website lead sync",
    schedule: "0 6 * * *",
    cadence: "Daily · 06:00 UTC",
    description: "Pulls new website enquiries from Sanity into the pipeline (also runs from the Sync button).",
    maxAgeMins: 26 * 60,
    endpoint: "/api/sync/sanity-leads",
  },
  {
    slug: "storage-billing",
    label: "Storage billing",
    schedule: "0 7 * * *",
    cadence: "Daily · 07:00 UTC",
    description: "Raises recurring storage invoices in Zoho and refreshes their paid/void status.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/storage-billing",
  },
  {
    slug: "chase",
    label: "Chase engine",
    schedule: "0 9 * * *",
    cadence: "Daily · 09:00 UTC",
    description: "Sends quote + deposit reminders, raises call tasks, and settles finished jobs.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/chase",
  },
  {
    slug: "crew-reminders",
    label: "Crew reminders",
    schedule: "0 17 * * *",
    cadence: "Daily · 17:00 UTC",
    description: "Emails each crew member the jobs they're assigned to tomorrow.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/crew-reminders",
  },
  {
    slug: "ai-retention",
    label: "AI media retention",
    schedule: "30 2 * * *",
    cadence: "Daily · 02:30 UTC",
    description: "Deletes expired AI survey video/media per the retention policy.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/ai-retention",
  },
  {
    slug: "card-reconcile",
    label: "Card payment reconciler",
    schedule: "*/15 * * * *",
    cadence: "Every 15 minutes",
    description: "Queries takepayments for any pending card deposit and confirms bookings a missed callback would have left hanging.",
    maxAgeMins: 45,
    endpoint: "/api/cron/card-reconcile",
  },
  {
    slug: "bank-feed",
    label: "Bank feed sync",
    schedule: "*/2 * * * *",
    cadence: "Every 2 minutes",
    description:
      "Reads the Monzo→Google-Sheets export and matches inbound transfers to awaiting deposits/balances for one-tap confirmation on Payments.",
    maxAgeMins: 15,
    endpoint: "/api/cron/bank-feed",
  },
];

/** A row from public.cron_runs (what the page + API return). */
export interface CronRunRow {
  id: string;
  job: string;
  status: "ok" | "error" | "skipped";
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}
