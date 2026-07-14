-- 0036: web-lead alert acknowledgement (Peter, 2026-07-14 — when a website
-- enquiry lands, every signed-in office user gets an audible chime + a
-- persistent banner until someone presses Acknowledge).
-- `web_alert_ack_at` = when the office acknowledged the new-web-lead alert.
-- NULL on an entry_channel='web' lead means "nobody has seen this yet" and
-- the dashboard poller keeps alarming. It is NOT first contact — that stays
-- `first_contacted_at`. No RLS change needed: leads_read/leads_update from
-- 0001 use is_staff(), policies are row-level (not column-level), and the
-- ack write goes through an office-gated server action anyway.

alter table leads add column if not exists web_alert_ack_at timestamptz;

comment on column leads.web_alert_ack_at is
  'When the office acknowledged the new-web-lead alert banner. NULL on a web lead = unacknowledged (dashboard alarms). Backfilled to now() on migration so pre-existing leads never alarm.';

-- Existing leads must NOT alarm the moment this ships — treat the whole
-- current funnel as already acknowledged.
update leads set web_alert_ack_at = now() where web_alert_ack_at is null;
