/**
 * The automation registry — the single source of truth for what scheduled jobs
 * exist, on what cadence, and how fresh a run should be before we call it
 * "overdue". Keep the `slug` in step with the string passed to runCron() in each
 * route. The /automations page reads this to show every automation, its
 * schedule, and its health.
 *
 * This registry is NOT the scheduler — the real one is /etc/cron.d/marley-ops on
 * the OVH box, firing cron-hit.sh (docs/ovh-deployment.md). Keep the two in step
 * by hand; this table only drives the dashboard.
 *
 * Schedules are UTC, because that box runs on UTC. Where a job must land at a
 * fixed UK wall-clock time it fires on BOTH candidate UTC hours and decides
 * inside the app which one is really that hour in London — see the chase engine
 * (lib/comms/send-window.ts) and crew sheets (lib/crew-sheet/dispatch.ts). A
 * single fixed UTC hour would drift by one hour across BST.
 *
 * `maxAgeMins` = if the newest successful run is older than this, flag the job
 * as overdue (a cheap "is this automation actually firing?" signal).
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
    schedule: "0 8,9 * * *",
    cadence: "Daily · customer emails at 09:00 UK",
    description:
      "Sends quote + deposit reminders, raises call tasks, and settles finished jobs. Fires on both UTC hours; only the one that is 09:00 in London sends anything to a customer.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/chase",
  },
  {
    slug: "crew-job-sheets",
    label: "Crew job sheets",
    schedule: "*/5 * * * *",
    cadence: "Every 5 minutes",
    description:
      "At 18:00 the evening before, emails each crew member their day-sheet PDF + texts a login-less link; re-sends a superseding copy within a tick when a job changes.",
    maxAgeMins: 20,
    endpoint: "/api/cron/crew-job-sheets",
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
  {
    slug: "job-media-transcribe",
    label: "Voice-note transcripts",
    schedule: "*/5 * * * *",
    cadence: "Every 5 minutes",
    description: "Transcribes voice notes captured on jobs (Gemini) so the office can read them in the Content queue.",
    maxAgeMins: 30,
    endpoint: "/api/cron/job-media-transcribe",
  },
  {
    slug: "weekly-digest",
    label: "Weekly owner digest",
    schedule: "0 6 * * 1",
    cadence: "Mondays · 06:00 UTC",
    description:
      "Emails Connor + Peter a short how-the-week-ran summary (money in, enquiries, wins, jobs done, what's coming) vs the week before.",
    maxAgeMins: 8 * 24 * 60,
    endpoint: "/api/cron/weekly-digest",
  },
  {
    slug: "health-watchdog",
    label: "Health watchdog",
    schedule: "*/15 * * * *",
    cadence: "Every 15 minutes",
    description:
      "Freshness-checks every automation + the bank feed and SMS-alerts the operator (6h cooldown) when something goes quiet.",
    maxAgeMins: 45,
    endpoint: "/api/cron/health-watchdog",
  },
  {
    slug: "comms-retry",
    label: "Message delivery retry",
    schedule: "*/5 * * * *",
    cadence: "Every 5 minutes",
    description:
      "Re-drives any customer email/SMS whose provider send failed or timed out, reusing the stored idempotency key so it can't double-send; escalates after repeated failures instead of dropping the message.",
    maxAgeMins: 20,
    endpoint: "/api/cron/comms-retry",
  },
  {
    slug: "fleet-reminders",
    label: "Fleet reminders",
    schedule: "0 7 * * *",
    cadence: "Daily · 07:00 UTC",
    description: "Emails and pushes due MOT, tax, insurance, service, and lease reminders without repeating a threshold.",
    maxAgeMins: 26 * 60,
    endpoint: "/api/cron/fleet-reminders",
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
