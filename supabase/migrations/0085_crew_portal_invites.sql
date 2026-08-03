-- Crew self-service portal invites. When an office admin activates a Staff &
-- Fleet member as a crew login, we mint a one-time, expiring invite token so the
-- crew member sets their OWN password (no admin-allocated password to hand out
-- over WhatsApp). Only the SHA-256 hash is stored, so a leak of the column never
-- yields a working link; the raw token lives only in the emailed URL. Single-use
-- (cleared on redemption) and time-boxed.

begin;

alter table public.profiles
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz,
  add column if not exists invite_sent_at timestamptz;

create index if not exists profiles_invite_token_hash_idx
  on public.profiles(invite_token_hash)
  where invite_token_hash is not null;

notify pgrst, 'reload schema';

commit;
