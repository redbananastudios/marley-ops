# Vehicle availability + fleet-expiry reminders — PRD

**Status:** build-ready (spec locked with Peter, 2026-07-17). Vehicles first; staff availability is a
separate later build that reuses the same availability table.

## Why

The Job Board capacity strip is **assignment-derived only** ([lib/job-board.ts](../lib/job-board.ts)):
a van shows "free" unless it's already pinned to a job that day. It has no idea a van is **off-road** (in
the garage for service/MOT/repair) or **expired** (MOT/tax/insurance lapsed → legally un-driveable). So the
capacity number reads headroom that isn't there and the office can book a move onto a van it can't use.
Separately, the three compliance dates already stored are surfaced as chips but nothing **reminds** anyone
before they lapse — the office finds out when it's too late.

Two fixes, kept deliberately simple:

1. **Availability** — record garage/off-road windows so an off-road van drops out of board capacity.
2. **Reminders** — a daily job that emails + alerts admin as each expiry approaches, from 4 weeks out.

## Fleet reality (Peter, 2026-07-17)

2× Luton vans, maybe a 3rd. **No 7.5t, no tachograph, no tail-lift/LOLER tracking.** The tracked expiries
are **MOT · Tax · Insurance · Lease end (`end_of_term`) · Service due**. The expiry set is a config list, so
tacho/tail-lift are a one-line addition if a 7.5t ever joins.

## Data model

- **`vehicles.service_due date`** (new column). `last_service` already exists; this is the next-due date that
  drives the "book it into the garage" reminder.
- **`vehicle_unavailability`** (new) — off-road windows.
  `(id, vehicle_id → vehicles cascade, start_date, end_date, reason, note, created_at, created_by)`,
  `end_date >= start_date`. Reasons: `service | mot | repair | other`. Office-write via RLS.
- **`vehicle_reminder_log`** (new) — the never-send-twice ledger.
  `(id, vehicle_id → vehicles cascade, expiry_type, due_date, threshold, sent_at)` with
  **unique(vehicle_id, expiry_type, due_date, threshold)**. Keying on `due_date` means renewing a date (pushing
  it out) starts a fresh reminder cycle automatically. Written by the cron via service role.
- **`business_settings`** — `fleet_reminders_enabled boolean default true`, `fleet_alert_recipients text[]`.

## Expiry config (`lib/vehicles.ts`)

Keep `VEHICLE_DOCS` (tax/mot/insurance — the legal chips, unchanged). Add a superset:

```
VEHICLE_EXPIRIES = [
  { key: "tax_due",            label: "Tax",       autoOffRoad: true  },
  { key: "mot_due",            label: "MOT",       autoOffRoad: true  },
  { key: "insurance_renewal",  label: "Insurance", autoOffRoad: true  },
  { key: "service_due",        label: "Service",   autoOffRoad: false },
  { key: "end_of_term",        label: "Lease end", autoOffRoad: false },
]
```

`autoOffRoad` = "can't legally drive when overdue" (MOT/Tax/Insurance). Service + lease are reminder-only.

## Availability (`lib/fleet/availability.ts`, pure)

`vehicleOffRoad(vehicle, unavailability[], ukDay)` → `{ offRoad, reason }`. A van is off-road on a day when:
- any `autoOffRoad` expiry is **overdue** on that day (reason e.g. "MOT overdue"), **or**
- an unavailability window covers that day (reason = the window's reason, e.g. "Service booked").

The Job Board (M2) excludes off-road vans from the "N/N free" numerator and greys them in the resource rail
with the reason. Assigning an off-road van still **warns, never blocks** — same philosophy as the clash warning.

## Reminders (`lib/fleet/reminders.ts` pure + `app/api/cron/fleet-reminders` daily)

**Cadence:** first alert at **28** days, then **14 · 7 · 3 · 0 (day-of)**, then **weekly while overdue**.

**Pure `dueReminders(vehicles, today, log)`** returns the `(vehicle, expiry_type, due_date, threshold)` alerts
to send now:
- For an expiry `days` away (≥0): the tightest threshold bucket reached (`days <= T`) that isn't in the log.
  When firing threshold T, the looser reached-but-unsent buckets are recorded as suppressed in the same run —
  so a date entered late (e.g. 5 days out) fires **once**, not 28+14+7+3 at once.
- Overdue (`days < 0`): a weekly `overdue` alert — due when the last `overdue` log row for this
  `(vehicle, type, due_date)` is >7 days old (or none).

**Cron** (daily, VBS-silent / Vercel cron): compute due → for each, send **email** (Resend, new
`fleet-expiry-reminder` template) + **web push** (new `fleet_expiry` category) + surface on the dashboard
**Fleet docs due** card (extended to a live list) → write the log rows. Recipients = `fleet_alert_recipients`
(seeded Peter/Connor/Luke; **Connor & Luke are still `@marleymoves.test` → sends route to the sink
`peter@abacusonline.net` until their real emails land at go-live**). Gated by `fleet_reminders_enabled`.

## UI (M4)

- **Vehicle edit** (`/resources`): add the **Service due** date; add/edit **off-road windows** (list with
  add — date range + reason). Compliance chips extend to render all five expiries.
- **Settings**: Fleet-alert recipients (editable list), reminders kill switch, "Send test alert" button.
- **Dashboard**: "Fleet docs due" becomes a live needs-action list (which van, which expiry, days left).

## Milestones

- **M1** — migration 0052 + `VEHICLE_EXPIRIES` + pure `availability.ts` + `reminders.ts` with TDD tests.
- **M2** — Job Board off-road (capacity + rail).
- **M3** — reminder cron + email + push + dashboard card.
- **M4** — Settings + vehicle-edit availability UI.

## Verification

- Pure logic TDD: threshold crossings (28/14/7/3/0), late-entry single-fire, weekly-overdue, UK-day/leap
  correctness, off-road-from-overdue, off-road-from-window.
- All local (Supabase `supabase_db_marley-ops` :54322). Migrations applied to prod by Peter at go-live.
- Green gate per milestone: `npm run lint` + `tsc --noEmit` + `vitest run` + `next build`.
- Test sends route to `peter@abacusonline.net` — never to Connor/Luke/customers.

## Out of scope (now)

Staff availability (next build). Tacho / tail-lift / O-licence. Half-day (AM/PM) off — whole-day only.
Recurring rota / working patterns.
