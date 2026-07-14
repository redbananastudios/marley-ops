-- 0038: gate next_quote_ref() behind is_office() (review finding, 2026-07-14).
-- The function only hands out a counter — no data exposure — but any
-- authenticated login (crew included) could call it and burn sequence values,
-- inflating the short references (MMR001 → MMR1000+) for no reason. Office RLS
-- already blocks crew from inserting quotes; this makes the counter match.
-- Interactive callers carry a user JWT (auth.uid() set) → must be office.
-- Service-role/system calls carry no user id → pass (anon has no execute grant
-- at all, so a null uid can only be the service role or a superuser).

create or replace function public.next_quote_ref(kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  n bigint;
begin
  if auth.uid() is not null and not public.is_office() then
    raise exception 'quote references are minted by office users only' using errcode = '42501';
  end if;

  if kind = 'R' then
    n := pg_catalog.nextval('public.quote_ref_mmr_seq');
  elsif kind = 'C' then
    n := pg_catalog.nextval('public.quote_ref_mmc_seq');
  else
    raise exception 'quote ref kind must be R or C, got %', kind using errcode = '22023';
  end if;
  return 'MM' || kind || pg_catalog.lpad(n::text, 3, '0');
end
$function$;
