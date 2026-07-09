-- Chase engine + loss capture. Additive only — safe over live data.
--
-- Chase state lives on the lead: the daily cron reads status + step counters
-- and sends the next due email (quoted: day 2/5/10 after the quote email;
-- provisional: day 1/3 after acceptance). chase_paused is the human/inbound
-- stop switch — flipped by a customer reply (Resend inbound webhook) or a tap.

alter table leads
  add column if not exists quote_chase_step    int not null default 0,
  add column if not exists quote_chase_at      timestamptz,
  add column if not exists deposit_chase_step  int not null default 0,
  add column if not exists deposit_chase_at    timestamptz,
  add column if not exists chase_paused        boolean not null default false,
  -- Loss capture: WHY we lost feeds the Performance breakdown. Set by the
  -- mark-lost dialog or the 30-day auto-lapse (reason 'no_response').
  add column if not exists lost_reason         text,
  add column if not exists lost_note           text,
  add column if not exists lost_at             timestamptz;

create index if not exists leads_chase_idx on leads(status)
  where status in ('quoted', 'provisional');
