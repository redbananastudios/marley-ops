-- 0040: passkey (WebAuthn) quick sign-in (Peter, 2026-07-15 — "I don't want to
-- type email + password every time"). Face ID on iOS, fingerprint on Android,
-- device PIN fallback — the platform authenticator handles all three. The
-- email + password path stays as the fallback; passkeys are additive.
--
--  auth_passkeys            one row per registered credential. The public key +
--                           signature counter are the ground truth we verify
--                           assertions against. credential_id is the browser's
--                           base64url credential id (unique). public_key is the
--                           COSE public key, base64url-encoded for text storage.
--  auth_passkey_challenges  short-lived (5 min) server-issued challenges for
--                           registration + authentication. The challenge is
--                           bound into the signed assertion, so a stored row
--                           proves we issued it; deleted after a successful use.
--  auth_passkey_attempts    failed-verify audit rows, used ONLY for the
--                           per-credential rate limit (max 10 failed verifies
--                           per credential id per hour). Kept tiny + append-only.
--
-- All three are touched exclusively by the service-role admin client from
-- trusted server actions (assertion verification, session minting, device
-- management). RLS is enabled with NO policies for the `authenticated` role so
-- an anon/user token can never read another user's credentials or forge a
-- challenge — the service role bypasses RLS, everyone else is denied by default.

create table auth_passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text,
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index auth_passkeys_user_idx on auth_passkeys(user_id);

create table auth_passkey_challenges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  challenge  text not null,
  kind       text not null check (kind in ('registration', 'authentication')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Verify looks a challenge up by its value (decoded from the signed assertion),
-- so index the value + expiry for the hot lookup.
create index auth_passkey_challenges_lookup_idx
  on auth_passkey_challenges(challenge, kind, expires_at);

create table auth_passkey_attempts (
  id            uuid primary key default gen_random_uuid(),
  credential_id text not null,
  created_at    timestamptz not null default now()
);

create index auth_passkey_attempts_rate_idx
  on auth_passkey_attempts(credential_id, created_at);

-- Service-role only: enable RLS but add NO policies. The authentication flow is
-- PUBLIC (a signed-out visitor asserts a passkey) yet must NEVER be able to read
-- credentials or challenges with an anon token — so all access goes through the
-- service-role admin client, which bypasses RLS. Default-deny for everyone else.
alter table auth_passkeys           enable row level security;
alter table auth_passkey_challenges enable row level security;
alter table auth_passkey_attempts   enable row level security;
