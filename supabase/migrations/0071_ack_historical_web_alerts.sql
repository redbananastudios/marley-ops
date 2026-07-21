-- Repair website rows imported after the original alert-column backfill but
-- before freshness-aware sync. The submitted/created gap identifies an import,
-- so a genuinely fresh lead that nobody has acknowledged remains untouched.

update public.leads
set web_alert_ack_at = now()
where web_alert_ack_at is null
  and entry_channel = 'web'
  and source_system = 'website'
  and submitted_at < now() - interval '24 hours'
  and created_at > submitted_at + interval '24 hours';
