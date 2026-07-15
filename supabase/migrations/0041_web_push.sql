-- 0041: Web Push notifications (Peter, 2026-07-15 — PRD docs/marley-ops-web-push-prd.md).
-- Standards-based Push API + VAPID, no Firebase. v1 categories: new_enquiry
-- (website lead committed) and payment_event (deposit/balance received), both
-- office-audience. Global + per-category kill switches live on
-- business_settings so pushes can be disabled without a deploy.
--
--  push_subscriptions  one row per browser push endpoint. An endpoint belongs
--                      to exactly ONE user at a time (unique endpoint_hash) —
--                      when a different user enables notifications on the same
--                      browser, ownership transfers to them. Peter's decision
--                      (2026-07-15): logout does NOT revoke — a device keeps
--                      notifying whoever last enabled it there.
--                      The endpoint + encryption keys are credential-like and
--                      stored plaintext (the app has no field-encryption
--                      mechanism to reuse — documented per PRD §14.1); access
--                      is service-role only, so RLS denial is the control.
--  push_preferences    one row per user; `categories` is a jsonb map of
--                      category id -> boolean, validated against the app-side
--                      allowlist. Missing keys fall back to the category's
--                      default. User-wide (applies to all their devices).
--
-- Both tables are touched exclusively by the service-role admin client from
-- trusted server actions / the push sender. RLS is enabled with NO policies so
-- an anon/user token can never read another user's endpoints or preferences.

create table push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  endpoint        text not null check (char_length(endpoint) <= 2048),
  endpoint_hash   text not null unique check (char_length(endpoint_hash) <= 64),
  p256dh          text not null check (char_length(p256dh) <= 512),
  auth_secret     text not null check (char_length(auth_secret) <= 512),
  expiration_time timestamptz,
  installation_id text check (char_length(installation_id) <= 128),
  user_agent      text check (char_length(user_agent) <= 512),
  status          text not null default 'active' check (status in ('active', 'revoked', 'invalid')),
  failure_count   integer not null default 0,
  last_seen_at    timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  revoked_at      timestamptz
);

-- The send path's hot lookup: all active subscriptions for a recipient set.
create index push_subscriptions_user_status_idx on push_subscriptions(user_id, status);

create table push_preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  categories jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
alter table push_preferences enable row level security;

-- Kill switches. Global default OFF — flipped on from Settings once Peter has
-- validated delivery on his devices. Per-category default ON so enabling the
-- system enables both v1 categories; either can be silenced independently.
alter table business_settings
  add column push_enabled boolean not null default false,
  add column push_new_enquiry_enabled boolean not null default true,
  add column push_payment_event_enabled boolean not null default true;
