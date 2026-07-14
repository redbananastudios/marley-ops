-- 0037: short, human-typable quote references (MMR001 / MMC001).
-- Customers quote the reference as their bank-transfer reference, so it must be
-- short and unambiguous. New refs are 'MM' + kind ('R' residential | 'C'
-- commercial) + a zero-padded, ever-growing counter (MMR001 … MMR999 → MMR1000).
-- Old MM-YYMMDD-NNN references on existing quotes are left untouched — the ref is
-- an opaque string everywhere (Zoho -DEP/-BAL adoption, chase engine, the /q
-- accept page and the PDFs all treat it as text; nothing parses the format).
--
-- Counters are plain sequences: gap-tolerant and collision-proof even when
-- quotes are deleted. The previous count-based scheme (count rows for today,
-- add one) re-issued a live reference after any delete — this replaces it.

create sequence if not exists public.quote_ref_mmr_seq as bigint start with 1 increment by 1 minvalue 1;
create sequence if not exists public.quote_ref_mmc_seq as bigint start with 1 increment by 1 minvalue 1;

-- next_quote_ref('R'|'C') → 'MMR001' | 'MMC001'. Runs SECURITY DEFINER purely to
-- own the sequences (authenticated has no direct grant on them); it hands out a
-- counter only. The office RLS on `quotes` still governs whether a row may be
-- inserted with the returned reference, so this is not a privilege escalation.
create or replace function public.next_quote_ref(kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  n bigint;
begin
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

revoke all on function public.next_quote_ref(text) from public, anon;
grant execute on function public.next_quote_ref(text) to authenticated, service_role;
